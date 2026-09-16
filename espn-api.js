// espn-api.js
// Client for ESPN's public (undocumented) scoreboard API.
// Fetches games + point spreads for NFL and FBS college football and
// maps them into the same game-object shape the admin panel already
// uses for Yahoo-pasted games (see importParsedGames() in
// dlc-admin-panel-firebase-FINAL.html) — so ESPN-sourced games drop
// straight into the existing games array, Firebase schema, picks page,
// scoring, and leaderboard with no changes needed there.
//
// Prefers the /api/espn-scoreboard serverless proxy (same-origin, no
// CORS issues, keeps ESPN's endpoint details server-side). Falls back
// to calling ESPN directly if the proxy isn't deployed yet.
//
// NOTE: not yet verified against a live response (this endpoint was
// unreachable from the environment this was written in). Test a real
// fetch after deploying and adjust _parseOddsDetails / mapEventToGame
// if ESPN's field names differ from what's documented here.

const ESPN_API = {
  PROXY_PATH: '/api/espn-scoreboard',

  LEAGUE_PATHS: {
    nfl: 'football/nfl',
    cfb: 'football/college-football'
  },

  async _fetchScoreboard(league, { week, season, seasontype = 2, dates } = {}) {
    // Querying by an explicit date range (`dates=YYYYMMDD-YYYYMMDD`) is the
    // more reliable way to get a full slate from ESPN — `week` numbering
    // doesn't always resolve to the games you'd expect, especially for
    // college football with its many groups/conferences, and can silently
    // fall back to just "today's" games instead of erroring.
    const params = new URLSearchParams();
    if (dates) {
      params.set('dates', dates);
    } else {
      params.set('seasontype', String(seasontype));
      if (week) params.set('week', String(week));
      if (season) params.set('year', String(season));
    }

    // 1. Try the same-origin serverless proxy first.
    try {
      const proxyUrl = `${this.PROXY_PATH}?league=${league}&${params}`;
      const res = await fetch(proxyUrl);
      if (res.ok) return await res.json();
      console.warn(`ESPN proxy responded ${res.status}, falling back to direct fetch`);
    } catch (e) {
      console.warn('ESPN proxy unreachable, falling back to direct fetch:', e.message);
    }

    // 2. Fall back to calling ESPN directly (works only if ESPN's CORS
    //    headers allow it from the browser; not guaranteed long-term,
    //    which is exactly why the proxy above is the preferred path).
    const path = this.LEAGUE_PATHS[league];
    if (league === 'cfb') params.set('groups', '80'); // FBS
    const directUrl = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?${params}`;
    const res = await fetch(directUrl);
    if (!res.ok) throw new Error(`ESPN API returned ${res.status} for ${league}`);
    return await res.json();
  },

  /**
   * Parses an ESPN odds "details" string like "DAL -3.5" or "PK" into
   * { favoriteAbbr, spread }. Returns null if there's no line yet.
   */
  _parseOddsDetails(details) {
    if (!details) return null;
    const trimmed = details.trim();
    if (/^(pk|even)$/i.test(trimmed)) return { favoriteAbbr: null, spread: 0 };
    const match = trimmed.match(/^([A-Z]{2,4})\s+(-?\d+\.?\d*)$/);
    if (!match) return null;
    return { favoriteAbbr: match[1], spread: parseFloat(match[2]) };
  },

  /**
   * Maps one ESPN scoreboard "event" into the app's game-object shape.
   * currentSpread follows the app's existing convention (see
   * parseYahooSpreads() in the admin panel): negative = home team
   * favored by that many points, positive = home team getting that
   * many points. Derived from the favorite's abbreviation rather than
   * trusting ESPN's raw spread sign, since that convention isn't
   * confirmed against a live response yet.
   */
  mapEventToGame(event, { league, week, season }) {
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const home = competition.competitors?.find(c => c.homeAway === 'home');
    const away = competition.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    const oddsDetails = competition.odds?.[0]?.details;
    const parsedOdds = this._parseOddsDetails(oddsDetails);

    let currentSpread = null;
    if (parsedOdds) {
      if (parsedOdds.favoriteAbbr === null) {
        currentSpread = 0; // pick'em
      } else if (parsedOdds.favoriteAbbr === home.team.abbreviation) {
        currentSpread = parsedOdds.spread; // already negative
      } else {
        currentSpread = Math.abs(parsedOdds.spread);
      }
    }

    const stateMap = { pre: 'scheduled', in: 'live', post: 'final' };
    const espnState = competition.status?.type?.state;

    // ESPN reports AP/CFP rank as curatedRank.current, using 99 for
    // "unranked" rather than omitting the field — only 1-25 counts.
    const rankOf = (competitor) => {
      const r = competitor.curatedRank?.current;
      return (typeof r === 'number' && r >= 1 && r <= 25) ? r : null;
    };

    return {
      id: `espn-${event.id}`,
      week: week ?? event.week?.number ?? null,
      season: season ?? null,
      league,
      homeTeam: home.team.displayName,
      homeAbbr: home.team.abbreviation,
      homeRank: rankOf(home),
      awayTeam: away.team.displayName,
      awayAbbr: away.team.abbreviation,
      awayRank: rankOf(away),
      gameTime: competition.date,
      currentSpread,
      spreadLastUpdated: new Date().toISOString(),
      finalSpread: null,
      status: stateMap[espnState] || 'scheduled',
      homeScore: espnState === 'pre' ? null : Number(home.score),
      awayScore: espnState === 'pre' ? null : Number(away.score),
      spreadResult: null,
      espnEventId: event.id
    };
  },

  /**
   * Fetches and maps every game for a given week/date-range across one or
   * more leagues. League labels ('NFL' / 'FBS') match what the rest of the
   * admin panel already uses for the `league` field.
   *
   * Pass `dates: 'YYYYMMDD-YYYYMMDD'`. ESPN no longer accepts a range in one
   * request — it answers 400 — so a range is split here and fetched a day at
   * a time, then recombined. A single `dates: 'YYYYMMDD'` still works as-is.
   * `week` and `season` tag the resulting game objects either way.
   *
   * After each call, `ESPN_API.lastFetchDebug` holds
   * `{ nfl: { raw, mapped }, cfb: { raw, mapped } }` — raw is how many
   * events ESPN actually returned, mapped is how many survived mapping.
   * A raw count that's way lower than expected means the query itself
   * (week/dates/season) is scoped too narrow; a gap between raw and
   * mapped means events are failing to map (check mapEventToGame).
   */
  /**
   * 'YYYYMMDD-YYYYMMDD' -> ['YYYYMMDD', …], inclusive. Anything that isn't a
   * range comes back untouched as a single entry.
   */
  _expandDateRange(dates) {
    if (!dates) return [null];
    const m = String(dates).match(/^(\d{8})-(\d{8})$/);
    if (!m) return [String(dates)];

    const parse = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const out = [];
    for (let d = parse(m[1]), end = parse(m[2]); d <= end && out.length < 31;
         d = new Date(d.getTime() + 86400000)) {
      out.push(fmt(d));
    }
    return out;
  },

  async fetchWeekGames({ week, season, seasontype = 2, dates, leagues = ['nfl', 'cfb'] }) {
    const labelFor = { nfl: 'NFL', cfb: 'FBS' };
    this.lastFetchDebug = {};

    // One request per day. ESPN used to take a whole range at once and now
    // answers 400 to any range, which broke importing a week outright — and
    // broke it quietly, since the caller just saw zero games.
    const days = this._expandDateRange(dates);

    const results = await Promise.all(
      leagues.map(async (league) => {
        const seen = new Set();
        const mapped = [];
        let raw = 0, failedDays = 0;

        for (const day of days) {
          let data;
          try {
            data = await this._fetchScoreboard(league, {
              week, season, seasontype, dates: day || undefined
            });
          } catch (e) {
            failedDays++;
            console.warn(`ESPN fetch failed for ${league} ${day}:`, e.message);
            continue;
          }
          const events = data.events || [];
          raw += events.length;
          for (const ev of events) {
            const game = this.mapEventToGame(ev, { league: labelFor[league], week, season });
            // A game can surface on two adjacent days once time zones are
            // involved, so de-duplicate before the caller ever sees it.
            if (game && !seen.has(String(game.id))) {
              seen.add(String(game.id));
              mapped.push(game);
            }
          }
        }

        this.lastFetchDebug[league] = {
          raw, mapped: mapped.length, days: days.length, failedDays
        };
        if (failedDays === days.length) {
          throw new Error(`ESPN returned no usable data for ${league} across ${days.length} day(s)`);
        }
        return mapped;
      })
    );
    return results.flat().sort((a, b) => new Date(a.gameTime) - new Date(b.gameTime));
  }
};

if (typeof window !== 'undefined') {
  window.ESPN_API = ESPN_API;
}
