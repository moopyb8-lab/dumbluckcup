// api/auto-score.js
// Vercel Cron target — the actual "score games automatically, no button
// press" path. vercel.json fires this once a day at 05:00 UTC (9 PM
// Pacific Standard Time). Vercel's Hobby plan only allows daily cron
// schedules — no hourly DST-correction trick here — so during Pacific
// Daylight Time (mid-March to early November) this actually lands at
// 10 PM local instead of 9 PM. That hour of drift is accepted as the
// cost of staying on a plan that permits at most one run a day; an
// hourly schedule with an in-function hour check was tried before and
// silently broke every deployment, since Hobby rejects the schedule
// itself regardless of what the code does once triggered.
//
// Unlike every other write path in this app, this one runs unattended
// with no human preview step: it reads the live games list straight from
// Firebase, checks ESPN for any that have gone final (only already-played
// games are touched — anything still scheduled or in-progress is left
// alone), and writes scores (and locks, for any game that wasn't locked
// yet) straight back to Firebase. Every point is still computed against
// the locked spread, same as everywhere else in this app — this just
// supplies the homeScore/awayScore/finalSpread that calculation reads.
// Mirrors syncFinalScoresFromESPN() in the admin panel exactly — same
// matching, same auto-lock rule, same "skip a finished game that never
// got a spread" rule — that button still exists for on-demand use between
// daily runs, or to catch anything a run of this misses (e.g. two games
// swapped home/away abbreviations by coincidence).
//
// This app has no Firebase Auth anywhere — the browser writes straight to
// Firebase with nothing but the public API key, which only works because
// the Realtime Database rules are already open. So this calls Firebase's
// REST API the same way, with no special credential. If a CRON_SECRET env
// var is set in the Vercel project, requests must carry it (Vercel's own
// cron trigger sends it automatically) — recommended defense in depth, but
// not required for this to work, since it doesn't change what's already
// unauthenticated at the database level.

const FIREBASE_DB_URL = 'https://dumb-luck-cup-default-rtdb.firebaseio.com';
const LEAGUE_PATHS = { nfl: 'football/nfl', cfb: 'football/college-football' };

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  try {
    const gamesRes = await fetch(`${FIREBASE_DB_URL}/games.json`);
    if (!gamesRes.ok) {
      res.status(502).json({ error: `Firebase read returned ${gamesRes.status}` });
      return;
    }
    const games = (await gamesRes.json()) || [];

    const unfinished = games.filter(g => g.status !== 'final');
    if (unfinished.length === 0) {
      res.status(200).json({ message: 'Nothing to sync — every loaded game is already final.', scored: 0 });
      return;
    }

    const times = unfinished.map(g => new Date(g.gameTime).getTime()).filter(t => !isNaN(t));
    if (times.length === 0) {
      res.status(200).json({ message: 'No valid game times to query ESPN with.', scored: 0 });
      return;
    }

    // Query a date range wide enough to cover every unfinished game's
    // kickoff, padded a day each way for time zone slop — same as the
    // admin panel's on-demand sync.
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const from = new Date(Math.min(...times)); from.setDate(from.getDate() - 1);
    const to = new Date(Math.max(...times)); to.setDate(to.getDate() + 1);
    const dates = `${fmt(from)}-${fmt(to)}`;

    const leagues = [...new Set(unfinished.map(g => g.league === 'NFL' ? 'nfl' : 'cfb'))];
    const espnGames = [];

    for (const league of leagues) {
      const path = LEAGUE_PATHS[league];
      const params = new URLSearchParams({ dates });
      if (league === 'cfb') params.set('groups', '80'); // FBS
      const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?${params}`;

      let espnRes;
      try {
        espnRes = await fetch(url);
      } catch (e) {
        console.error(`ESPN fetch failed for ${league}:`, e.message);
        continue;
      }
      if (!espnRes.ok) continue;
      const data = await espnRes.json();
      const label = league === 'nfl' ? 'NFL' : 'FBS';

      for (const event of (data.events || [])) {
        const competition = event.competitions?.[0];
        const home = competition?.competitors?.find(c => c.homeAway === 'home');
        const away = competition?.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        const state = competition.status?.type?.state;
        espnGames.push({
          league: label,
          homeAbbr: home.team.abbreviation,
          awayAbbr: away.team.abbreviation,
          gameTime: competition.date,
          status: state === 'post' ? 'final' : (state === 'in' ? 'live' : 'scheduled'),
          homeScore: state === 'pre' ? null : Number(home.score),
          awayScore: state === 'pre' ? null : Number(away.score),
          espnEventId: event.id
        });
      }
    }

    let scored = 0, locked = 0, skippedNoSpread = 0;
    for (const game of unfinished) {
      // ESPN-imported games carry the event id they came from — an exact
      // match. Yahoo-pasted or manually-added games don't have one, so
      // fall back to matching on league + both team abbreviations — but
      // that alone isn't unique across a multi-day query window (the
      // same two abbreviations can recur across weeks, or ESPN can reuse
      // a short code between two different schools), so a fallback match
      // is only trusted when its kickoff is within a day of this game's
      // own kickoff. Without that, a still-live game could get matched to
      // an unrelated already-finished event and marked final by mistake.
      const match = espnGames.find(e => {
        if (game.espnEventId) return e.espnEventId === game.espnEventId;
        if (e.league !== game.league || e.homeAbbr !== game.homeAbbr || e.awayAbbr !== game.awayAbbr) return false;
        const hoursApart = Math.abs(new Date(e.gameTime) - new Date(game.gameTime)) / 3600000;
        return hoursApart <= 24;
      });
      if (!match || match.status !== 'final') continue;
      if (match.homeScore === null || match.awayScore === null ||
          Number.isNaN(match.homeScore) || Number.isNaN(match.awayScore)) continue;

      if (game.finalSpread === null) {
        // Can't score a cover without a locked spread, and can't lock a
        // spread that was never set (a "No Available Spread" PK game) —
        // leave those for the admin to review by hand.
        if (game.currentSpread === null || Number.isNaN(game.currentSpread)) {
          skippedNoSpread++;
          continue;
        }
        game.finalSpread = game.currentSpread;
        locked++;
      }

      game.homeScore = match.homeScore;
      game.awayScore = match.awayScore;
      game.status = 'final';
      scored++;
    }

    if (scored > 0) {
      const writeRes = await fetch(`${FIREBASE_DB_URL}/games.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(games)
      });
      if (!writeRes.ok) {
        res.status(502).json({ error: `Firebase write returned ${writeRes.status}`, scored, locked, skippedNoSpread });
        return;
      }
    }

    res.status(200).json({ scored, locked, skippedNoSpread, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error('auto-score failed:', err);
    res.status(500).json({ error: err.message });
  }
};
