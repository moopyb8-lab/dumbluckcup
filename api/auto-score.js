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

// A spread only counts as "set" if it's a real number. null, undefined,
// and literal NaN (old bad data, or a value Firebase dropped on a prior
// write) all mean "not usable" — a plain "=== null" check misses the
// other two, which is how a game with an undefined/NaN finalSpread could
// get treated as already-locked and scored anyway with that bad spread
// still attached, handing every pick on it an automatic loss.
function isValidSpread(v) {
  return v !== null && v !== undefined && !Number.isNaN(v);
}

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

    // ESPN has stopped accepting date-range queries. `dates=YYYYMMDD-YYYYMMDD`
    // now returns 400 for both leagues, and the failure was silent here: the
    // !espnRes.ok guard skipped the league, espnGames stayed empty, nothing
    // matched, and the endpoint still answered 200 with scored: 0. A whole
    // week could go unscored with the cron reporting success every night.
    // Single dates still work, so ask for one day at a time.
    //
    // The days must be ESPN's, which is to say US Eastern, not UTC. A 5:15pm
    // Pacific Thursday kickoff is 00:15 UTC on Friday, so deriving the day
    // from the UTC timestamp would ask ESPN for the wrong date and find
    // nothing. Each kickoff contributes its own day plus the one either side,
    // which covers any remaining time zone slop.
    const etDay = (d) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d).replace(/-/g, '');
    const shiftDays = (d, n) => new Date(d.getTime() + n * 86400000);

    const dateSet = new Set();
    for (const t of times) {
      const d = new Date(t);
      dateSet.add(etDay(shiftDays(d, -1)));
      dateSet.add(etDay(d));
      dateSet.add(etDay(shiftDays(d, 1)));
    }
    // A stale unfinished game from an old week would otherwise stretch this
    // to dozens of requests. Two weeks of days is far more than any live
    // slate needs.
    const dates = [...dateSet].sort().slice(-16);

    const leagues = [...new Set(unfinished.map(g =>
      String(g.league || '').toUpperCase() === 'NFL' ? 'nfl' : 'cfb'))];
    const espnGames = [];
    let espnOk = 0, espnFailed = 0;

    for (const league of leagues) {
      for (const day of dates) {
      const path = LEAGUE_PATHS[league];
      const params = new URLSearchParams({ dates: day });
      if (league === 'cfb') params.set('groups', '80'); // FBS
      const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?${params}`;

      let espnRes;
      try {
        espnRes = await fetch(url);
      } catch (e) {
        espnFailed++;
        console.error(`ESPN fetch failed for ${league} ${day}:`, e.message);
        continue;
      }
      if (!espnRes.ok) {
        espnFailed++;
        console.error(`ESPN returned ${espnRes.status} for ${league} ${day}`);
        continue;
      }
      espnOk++;
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
    }

    // If every single request to ESPN failed there is nothing to match
    // against, and carrying on would report a cheerful "scored: 0" — which
    // is exactly how the date-range break went unnoticed. Say so instead.
    if (espnOk === 0 && espnFailed > 0) {
      res.status(502).json({
        error: 'Every ESPN request failed — nothing could be scored.',
        espnOk, espnFailed, dates, leagues
      });
      return;
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

      // The score gets loaded either way — a missing spread used to skip
      // the whole game, which meant it never showed up as final at all
      // until someone noticed and set a spread first. Now it always loads
      // with its real score; only the lock is skipped when there's no
      // spread to lock (never set, or a "No Available Spread" PK game),
      // leaving finalSpread null so it's correctly excluded from scoring
      // until the admin sets a spread by hand and locks it themselves.
      if (!isValidSpread(game.finalSpread)) {
        if (isValidSpread(game.currentSpread)) {
          game.finalSpread = game.currentSpread;
          locked++;
        } else {
          skippedNoSpread++;
        }
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

    res.status(200).json({
      scored, locked, skippedNoSpread,
      espnOk, espnFailed, daysQueried: dates.length,
      checkedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('auto-score failed:', err);
    res.status(500).json({ error: err.message });
  }
};
