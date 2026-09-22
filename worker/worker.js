/* Scrub Club API: api.scrubclubhockeyteam.com
 *
 * The team's data lives in the Scrub Club Airtable base (Roster and Games tables). This
 * Worker is the only thing that holds the Airtable token: it serves the site the public
 * columns, runs the email-code sign-in for In/Out, and writes the site's Beer Man, award
 * and USA Hockey entries.
 *
 * Sign-in is a six-digit code emailed to the address on a player's Roster row, so nobody
 * can answer for anyone else and there is no password to forget. The Roster is the
 * allowlist: to let someone sign in, fill in the Email field on their row; to lock them
 * out, clear it (their session stops working the next time the roster copy refreshes).
 *
 *   GET  /                  greeting
 *   POST /auth/start        {email}        emails a code if the email is on the roster
 *   POST /auth/verify       {email, code}  -> {token, name}; the token is a Bearer token
 *   GET  /me                Bearer         -> {name, email}
 *   POST /auth/signout      Bearer         drops the session
 *   POST /usah              Bearer, {value} writes your USA Hockey number to your Roster row
 *                                          (the newest "USA Hockey, <year>" field)
 *   GET  /public[?fresh=1]                 -> {roster, schedule}: the public columns, shaped like
 *                                          the old sheet (row arrays) so the site reads them as before
 *   POST /assign            {date, name, season, seasonHeader, seasonKey, award?}
 *                                          puts a teammate on Beer Duty (or gives Third Beer /
 *                                          Scrub Daddy, award: "third" | "daddy") for a game
 *   GET  /rsvp?season=W      Bearer          -> {games: {"Sep 22, 2026": {"JP Coakley": {a, t}}}}
 *                                          401 when signed out (JP, Sep 21, 2026: who's In/Out
 *                                          is for the roster only, not anyone who finds the site)
 *   POST /rsvp              Bearer, {season, date, answer: "in" | "out" | "", name?}
 *                           name = a teammate on the roster, to answer for them
 *                           date carries " · slug" when the game shares its date with another
 *                           schedule.json entry (an event); that keeps their answers apart
 *   GET  /schedule.ics                     -> text/calendar, every season in schedule.json as a
 *                                          subscribable feed (webcal, not a one-time import): dates,
 *                                          times and rinks are public like the rest of the schedule;
 *                                          each game's notes carry the result once played and who
 *                                          has Beer Duty, from the same Games table the site reads.
 *                                          No sign-in: it carries nothing that /rsvp now gates.
 *
 * Storage (KV):
 *   sess:<token>            {email, at, renewed}              a year, renewed weekly by /me
 *   otp:<email>             {hash, tries}                     10 minutes
 *   rl:<what>:<who>         counter                           rate limits
 *   lock:assign:<ymd>       "1"                               a minute, while an assignment writes
 *   cache:schema            {usah: [...], seasons: [...], at}  the Roster's year and season fields (a day)
 *   cache:roster2           {emails: {email: name}, names, at}   no expiry
 *   cache:public            {data: {roster, schedule}, at}       no expiry
 *   rsvp:<season>:<ymd>:<name>   value "in" | "out", metadata {a, t, d}
 *
 * Airtable's free plan allows about 1,000 API calls a month per workspace, so the copies in
 * KV are the normal source and Airtable is read only when a copy is older than PUBLIC_MAX_AGE_MS
 * (in the background, after answering from the copy), right after the site writes something,
 * for ?fresh=1 at most once a minute, and when an unknown email tries to sign in (at most once
 * a minute). A failed read falls back to the last good copy.
 *
 * One rsvp key per player per game means two people tapping at once can't overwrite each
 * other, and a season's answers come back from one list() call because the answer rides in
 * the key's metadata. A game is only answerable while it is on schedule.json, unplayed, and
 * today or later (Eastern time).
 */

const AT_BASE = "appCz1cVjdb97VIH3";
const AT_ROSTER = "tblFtcC4EtRuKsONI";
const AT_GAMES = "tblmugGYBH1Y3bsHa";
// Airtable answers in well under a second; past this a request uses the last good copy
const AT_TIMEOUT_MS = 10 * 1000;
// Field names in the base. Renaming a field there means renaming it here.
const F = {
  name: "Name", first: "First", last: "Last", jersey: "Jersey #", email: "Email",
  date: "Date", season: "Season", type: "Type", opponent: "Opponent", us: "Us", them: "Them",
  outcome: "Outcome", beer: "Beer Duty", third: "Third Beer", daddy: "Scrub Daddy",
  nickname: "Nickname",
};
// Roster fields the site gets: the newest USA Hockey year and every season status column
const USAH_RE = /^USA Hockey,?\s*(\d{4})$/;
const SEASON_RE = /^(Winter|Spring|Summer|Fall),\s*\d{2}(-\d{2})?$/;
const SEASON_NAMES = ["Winter", "Spring", "Summer", "Fall"];
// Statuses that count as on the team; keep in step with ON_TEAM in index.html
const ON_TEAM = ["in", "paid", "half", "goalie"];
// What the site may fill in on a Games row, by the site's kind name
const ASSIGN_FIELDS = { beer: F.beer, third: F.third, daddy: F.daddy };
// Where the site's column fallbacks expect the roster columns (0-based, from the old sheet)
// nickname (column Q) is new with the Airtable move (JP, Sep 22, 2026): the site shows it in place of a first name
const GRID = { usahEnd: 9, jersey: 11, first: 14, last: 15, nickname: 16, seasonsFrom: 20, headerRow: 6 };

// A public copy older than this is refreshed behind the response
const PUBLIC_MAX_AGE_MS = 4 * 60 * 60 * 1000;
// The roster copy (sign-in) refreshes on the same schedule
const ROSTER_MAX_AGE_MS = PUBLIC_MAX_AGE_MS;
// ?fresh=1, or an email that isn't on the copy, re-reads Airtable at most this often
const RECHECK_MS = 60 * 1000;
// The field list is nearly static; re-read it this often
const SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_URL = "https://scrubclubhockeyteam.com/schedule.json";
// Emails that sign in even when the roster doesn't list them, and who they are
const EXTRA_EMAILS = { "jpcoakley@gmail.com": "JP Coakley" };
// Pages allowed to call this (the site, plus the local preview)
const ORIGINS = [
  "https://scrubclubhockeyteam.com", "https://www.scrubclubhockeyteam.com",
  "http://127.0.0.1:8471", "http://localhost:8471",
];
const SESSION_TTL = 365 * 86400;
const TZ = "America/New_York";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const enc = new TextEncoder();
// Mirrors index.html's SEASONS "years" field, so /schedule.ics can date a "Sep 10" line without a
// year. Keep in step with SEASONS there when a season is added or archived.
const SEASON_YEARS = {
  W: [2026, 2027], V: [2026], U: [2026],
  w2526: [2025, 2026], s25: [2025], sp25: [2025], w2425: [2024, 2025], s24: [2024],
};

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request.headers.get("Origin") || "");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await route(request, env, ctx); }
    catch (e) {
      console.error("unhandled", String(e && e.stack || e));
      res = json({ ok: false, error: "Something went wrong. Try again." }, 500);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  if (m === "GET" && p === "/") return json({ ok: true, message: "Scrub Club API is running." });

  // ---- sign-in: ask for a code ----
  if (m === "POST" && p === "/auth/start") {
    const body = await readJson(request);
    const email = normEmail(body.email);
    if (!emailish(email)) return json({ ok: false, error: "That's not an email address." }, 400);
    // No cap per address (JP hit the old one on day one); one per network address
    // keeps a script from flooding a teammate's inbox
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    if (await overLimit(env, "ip:" + ip, 60, 3600)) {
      return json({ ok: false, error: "Too many codes sent. Try again in an hour." }, 429);
    }
    const name = await nameForEmail(env, email);
    if (!name) {
      await refund(env, "ip:" + ip);
      return json({ ok: false, unknown: true });
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    await env.SC_KV.put("otp:" + email,
      JSON.stringify({ hash: await codeHash(code, email), tries: 0 }),
      { expirationTtl: 600 });
    try {
      await sendMail(env, email, "Your Scrub Club sign-in code",
        "Hi " + name.split(" ")[0] + ",\n\n" +
        "Your Scrub Club sign-in code is:\n" + code + "\n\n" +
        "It's good for 10 minutes.");
    } catch (e) {
      const why = String((e && (e.code || e.message)) || e);
      console.error("code not sent", email, why);
      await env.SC_KV.delete("otp:" + email);
      await refund(env, "ip:" + ip);
      if (/SUPPRESS/i.test(why)) {
        return json({ ok: false, error: "Your email provider turned away our last message. " +
          "Check that your inbox isn't full, then try again tomorrow or text JP." }, 502);
      }
      return json({ ok: false, error: "Couldn't send the email. Try again." }, 502);
    }
    return json({ ok: true });
  }

  // ---- sign-in: turn the code into a session ----
  if (m === "POST" && p === "/auth/verify") {
    const body = await readJson(request);
    const email = normEmail(body.email);
    const code = String(body.code || "").replace(/\D/g, "");
    const doc = await env.SC_KV.get("otp:" + email, "json");
    if (!doc) return json({ ok: false, error: "That code expired. Ask for a new one." }, 400);
    if (doc.tries >= 5) {
      await env.SC_KV.delete("otp:" + email);
      return json({ ok: false, error: "Too many tries. Ask for a new code." }, 429);
    }
    if (doc.hash !== await codeHash(code, email)) {
      doc.tries += 1;
      await env.SC_KV.put("otp:" + email, JSON.stringify(doc), { expirationTtl: 600 });
      return json({ ok: false, error: "That's not it. Check the code." }, 401);
    }
    await env.SC_KV.delete("otp:" + email);
    const name = await nameForEmail(env, email);
    if (!name) return json({ ok: false, error: "That email isn't on the roster any more." }, 403);
    const token = randomToken();
    await env.SC_KV.put("sess:" + token, JSON.stringify({ email, at: Date.now() }),
      { expirationTtl: SESSION_TTL });
    return json({ ok: true, token, name }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (m === "GET" && p === "/me") {
    const me = await whoami(request, env);
    if (!me) return json({ ok: false, error: "Not signed in." }, 401);
    // A visit more than a week after the last renewal pushes the session's expiry out
    // another year, so a player who keeps using the site on one phone never signs in
    // again. Not on every visit: a KV read can be a minute stale, and renewing a session
    // that was just signed out would bring it back.
    if (Date.now() - (me.renewed || me.at) > 7 * 86400000) {
      await env.SC_KV.put("sess:" + me.token,
        JSON.stringify({ email: me.email, at: me.at, renewed: Date.now() }),
        { expirationTtl: SESSION_TTL });
    }
    return json({ ok: true, name: me.name, email: me.email }, 200, { "Set-Cookie": sessionCookie(me.token) });
  }

  if (m === "POST" && p === "/auth/signout") {
    const token = bearer(request);
    if (token) await env.SC_KV.delete("sess:" + token);
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  // ---- your USA Hockey number, onto your own Roster row ----
  if (m === "POST" && p === "/usah") {
    const me = await whoami(request, env);
    if (!me) return json({ ok: false, error: "Not signed in." }, 401);
    const body = await readJson(request);
    const value = String(body.value || "").toUpperCase().replace(/[\s-]/g, "");
    if (value && !/^[0-9A-Z]{4,24}$/.test(value)) {
      return json({ ok: false, error: "That doesn't look like a USA Hockey number." }, 400);
    }
    let out;
    try {
      const schema = await schemaFields(env);
      const field = schema.usah[schema.usah.length - 1];
      if (!field) return json({ ok: false, error: "The roster has no USA Hockey column." }, 500);
      const rec = (await atList(env, AT_ROSTER)).find((r) => norm(playerName(r)) === norm(me.name));
      if (!rec) return json({ ok: false, error: "That name isn't on the roster." }, 400);
      await at(env, `${AT_BASE}/${AT_ROSTER}`, { method: "PATCH",
        body: JSON.stringify({ records: [{ id: rec.id, fields: { [field]: value || null } }] }) });
      out = { ok: true, name: me.name, value, column: field };
    } catch (e) {
      console.error("usah", me.name, String(e));
      return json({ ok: false, error: "Couldn't reach the team roster. Try again." }, 502);
    }
    // The site's copy of the roster shows it once this lands
    ctx.waitUntil(refreshPublic(env).catch((e) => console.error("public refresh after usah", String(e))));
    return json(out);
  }

  // ---- the roster's public columns and the game log, for the site ----
  if (m === "GET" && p === "/public") {
    const data = await publicData(env, ctx, url.searchParams.get("fresh") === "1");
    return json(Object.assign({ ok: true }, data));
  }

  // ---- Beer Man and awards: fill one empty cell on a game's row ----
  if (m === "POST" && p === "/assign") {
    const body = await readJson(request);
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    if (await overLimit(env, "assign:" + ip, 30, 3600)) {
      return json({ ok: false, error: "Too many requests. Try again in an hour." }, 429);
    }
    let out;
    try { out = await assign(env, body); }
    catch (e) {
      console.error("assign", String(e));
      return json({ ok: false, error: "Couldn't reach the team roster. Try again." }, 502);
    }
    if (out.ok) ctx.waitUntil(refreshPublic(env).catch((e) => console.error("public refresh after assign", String(e))));
    return json(out, out.ok ? 200 : 400);
  }

  // ---- who's in and out, one season at a time (roster only, JP Sep 21, 2026) ----
  if (m === "GET" && p === "/rsvp") {
    const me = await whoami(request, env);
    if (!me) return json({ ok: false, error: "Sign in to see who's playing." }, 401);
    const season = String(url.searchParams.get("season") || "").trim();
    if (!/^[A-Za-z0-9_-]{1,12}$/.test(season)) return json({ ok: false, error: "Bad season." }, 400);
    return json({ ok: true, season, games: await answersFor(env, season) });
  }

  if (m === "POST" && p === "/rsvp") {
    const me = await whoami(request, env);
    if (!me) return json({ ok: false, error: "Not signed in." }, 401);
    const body = await readJson(request);
    const season = String(body.season || "").trim();
    const answer = String(body.answer || "").trim().toLowerCase();
    if (!["in", "out", ""].includes(answer)) return json({ ok: false, error: "Answer In or Out." }, 400);
    const game = await gameCheck(season, String(body.date || "").trim());
    if (game.error) return json({ ok: false, error: game.error }, 400);
    // Anyone signed in can answer for a teammate; the roster says who counts as one
    const name = String(body.name || "").replace(/\s+/g, " ").trim() || me.name;
    if (name !== me.name && !(await isRosterName(env, name))) {
      return json({ ok: false, error: "That name isn't on the roster." }, 400);
    }
    // A slug (an event sharing its date with a game) gets its own KV key segment, so a plain
    // date never collides with a slugged one on the same day
    const key = `rsvp:${season}:${game.ymd}${game.slug ? "#" + game.slug : ""}:${name}`;
    if (answer) {
      // Who answered isn't kept: an answer given for a teammate reads the same as their own
      await env.SC_KV.put(key, answer, { metadata: { a: answer, t: Date.now(), d: game.date } });
    } else {
      await env.SC_KV.delete(key);
    }
    return json({ ok: true, season, date: game.date, name, answer });
  }

  // ---- the schedule as a calendar feed, for a person to subscribe to (not a one-time import) ----
  if (m === "GET" && p === "/schedule.ics") {
    const sched = await schedule();
    let beerMap = {};
    try {
      const pub = await publicData(env, ctx, false);
      beerMap = beerByDate(pub.schedule, beerNamer(pub.roster));
    }
    catch (e) { console.error("schedule.ics beer lookup", String(e)); } // the feed still works without it
    return icsResponse(buildScheduleIcs(sched, beerMap));
  }

  return json({ ok: false, error: "No such endpoint." }, 404);
}

/* ---------------- who is asking ---------------- */

// The token comes as a Bearer header (the page keeps it in localStorage) or, when
// Safari has cleared that storage, as the cookie set at sign-in. Both name the same
// KV session, so signing out kills both.
function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+([A-Za-z0-9_-]{20,80})$/);
  if (m) return m[1];
  const c = cookieValue(request, "scrub");
  return /^[A-Za-z0-9_-]{20,80}$/.test(c) ? c : "";
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    if (part.startsWith(name + "=")) return part.slice(name.length + 1);
  }
  return "";
}

// Domain-wide so the site's own pages carry it to the api host; HttpOnly and set by
// the server, so Safari's seven-day purge of script-written storage leaves it alone
function sessionCookie(token) {
  return `scrub=${token}; Domain=scrubclubhockeyteam.com; Path=/; Max-Age=${SESSION_TTL}; ` +
         "HttpOnly; Secure; SameSite=Lax";
}
function clearSessionCookie() {
  return "scrub=; Domain=scrubclubhockeyteam.com; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

// A live session whose email is still on the roster; the roster can revoke anyone
async function whoami(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const sess = await env.SC_KV.get("sess:" + token, "json");
  if (!sess || !sess.email) return null;
  const name = await nameForEmail(env, sess.email);
  if (!name) return null;
  return { email: sess.email, name, token, at: sess.at || Date.now(), renewed: sess.renewed || 0 };
}

/* ---------------- Airtable ---------------- */

async function at(env, path, init = {}) {
  if (!env.AIRTABLE_TOKEN) throw new Error("AIRTABLE_TOKEN secret is not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AT_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.airtable.com/v0/" + path, Object.assign({}, init, {
      signal: ctl.signal,
      headers: Object.assign({ "Authorization": "Bearer " + env.AIRTABLE_TOKEN, "Content-Type": "application/json" }, init.headers || {}),
    }));
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) {
      const why = body && body.error ? (body.error.message || body.error.type || String(body.error)) : "";
      throw new Error("airtable " + r.status + (why ? ": " + why : ""));
    }
    return body || {};
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`airtable took over ${AT_TIMEOUT_MS / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Every record of a table (Airtable pages 100 at a time)
async function atList(env, table, params = {}) {
  const out = [];
  let offset;
  do {
    const q = new URLSearchParams(Object.assign({ pageSize: "100" }, params));
    if (offset) q.set("offset", offset);
    const body = await at(env, `${AT_BASE}/${table}?${q}`);
    out.push(...(body.records || []));
    offset = body.offset;
  } while (offset);
  return out;
}

// The Roster's USA Hockey fields (oldest to newest year) and season status fields, in the
// base's own field order; cached a day because the list only changes when JP adds a season
async function schemaFields(env, force) {
  const copy = await env.SC_KV.get("cache:schema", "json");
  if (copy && !force && Date.now() - (copy.at || 0) < SCHEMA_MAX_AGE_MS) return copy;
  let fields;
  try {
    const tables = (await at(env, `meta/bases/${AT_BASE}/tables`)).tables || [];
    fields = (tables.find((t) => t.id === AT_ROSTER) || {}).fields || [];
  } catch (e) {
    if (copy) { console.error("schema refresh failed, using the copy:", String(e)); return copy; }
    throw e;
  }
  const usah = fields.map((f) => f.name).filter((n) => USAH_RE.test(n))
    .sort((a, b) => +a.match(USAH_RE)[1] - +b.match(USAH_RE)[1]);
  const seasons = fields.filter((f) => f.type === "singleSelect" && SEASON_RE.test(f.name)).map((f) => f.name);
  const fresh = { usah, seasons, at: Date.now() };
  await env.SC_KV.put("cache:schema", JSON.stringify(fresh));
  return fresh;
}

function playerName(rec) {
  const f = rec.fields || {};
  return String(f[F.name] || `${f[F.first] || ""} ${f[F.last] || ""}`).replace(/\s+/g, " ").trim();
}

// {emails: {email: "First Last"}, names} from the Roster
async function fetchRoster(env) {
  const recs = await atList(env, AT_ROSTER, { "fields[]": [F.name, F.first, F.last, F.email] });
  const emails = {}, names = [];
  for (const r of recs) {
    const name = playerName(r);
    if (!name) continue;
    if (!names.includes(name)) names.push(name);
    for (const e of String((r.fields || {})[F.email] || "").split(/[\s,;]+/).map(normEmail)) {
      if (emailish(e) && !(e in emails)) emails[e] = name;
    }
  }
  for (const [e, n] of Object.entries(EXTRA_EMAILS)) {
    if (!(e in emails)) emails[e] = n;
    if (!names.includes(n)) names.push(n);
  }
  return { emails, names };
}

// {roster, schedule}: row arrays shaped like the old sheet. The roster keeps the header row where
// the site expects it (HEADER_ROW 7) with only names, jersey numbers, USA Hockey numbers and
// season statuses filled in: no emails, phones, Venmo or dues. The schedule is the Games table.
async function fetchPublic(env, force) {
  const schema = await schemaFields(env, force);
  const [players, games] = await Promise.all([atList(env, AT_ROSTER), atList(env, AT_GAMES)]);
  return { roster: rosterGrid(schema, players), schedule: scheduleGrid(players, games) };
}

function rosterGrid(schema, players) {
  const header = [];
  const put = (i, name) => { header[i] = name; };
  schema.usah.forEach((n, k) => put(Math.max(0, GRID.usahEnd - (schema.usah.length - 1 - k)), n));
  put(GRID.jersey, F.jersey); put(GRID.first, F.first); put(GRID.last, F.last); put(GRID.nickname, F.nickname);
  schema.seasons.forEach((n, k) => put(GRID.seasonsFrom + k, n));
  const width = header.length;
  for (let i = 0; i < width; i++) if (header[i] == null) header[i] = "";
  const blank = () => new Array(width).fill("");
  const rows = [];
  for (let i = 0; i < GRID.headerRow; i++) rows.push(blank());
  rows.push(header);
  const col = (name) => header.indexOf(name);
  const sorted = players.slice().sort((a, b) => playerName(a).localeCompare(playerName(b)));
  for (const p of sorted) {
    const f = p.fields || {};
    if (!playerName(p)) continue;
    const row = blank();
    row[col(F.first)] = str(f[F.first]);
    row[col(F.last)] = str(f[F.last]);
    row[col(F.nickname)] = str(f[F.nickname]);
    row[col(F.jersey)] = str(f[F.jersey]);
    for (const n of schema.usah) row[col(n)] = str(f[n]);
    for (const n of schema.seasons) row[col(n)] = str(f[n]);
    rows.push(row);
  }
  return rows;
}

function scheduleGrid(players, games) {
  const nameOf = {};
  for (const p of players) nameOf[p.id] = playerName(p);
  const linked = (v) => Array.isArray(v) && v.length ? (nameOf[v[0]] || "") : "";
  const head = ["Season", "Type", "Month", "Year", "Date", "Beer Duty", "Opponent", "Us", "Them", "Outcome", "Third Beer", "Scrub Daddy"];
  const rows = games.filter((g) => /^\d{4}-\d{2}-\d{2}$/.test(String((g.fields || {})[F.date] || "")))
    .sort((a, b) => a.fields[F.date] < b.fields[F.date] ? -1 : a.fields[F.date] > b.fields[F.date] ? 1 : 0)
    .map((g) => {
      const f = g.fields;
      const [y, mo, d] = f[F.date].split("-").map(Number);
      return [str(f[F.season]), str(f[F.type]), String(mo), String(y), `${MONTHS[mo - 1]} ${d}, ${y}`,
        linked(f[F.beer]), str(f[F.opponent]), str(f[F.us]), str(f[F.them]), str(f[F.outcome]),
        linked(f[F.third]), linked(f[F.daddy])];
    });
  return [head].concat(rows);
}

function str(v) { return v == null ? "" : String(v).trim(); }

/* ---------------- Beer Man and awards ---------------- */

// {date:"Sep 15, 2026", name, season:"Winter", seasonHeader:"Winter, 26-27", seasonKey:"W", award?}
// An assignment goes through only when the name is on that season's team (status In, Paid, Half
// or Goalie in the seasonHeader field), the date is a game on schedule.json (beer: unplayed and
// today or later; an award: today or earlier), and that field on the game's row is still empty.
// It fills the row for that date, adding one if there isn't one. Changing or clearing a name is
// done by hand in Airtable.
async function assign(env, req) {
  const kind = req.award ? String(req.award) : "beer";
  const field = ASSIGN_FIELDS[kind];
  if (!field) return { ok: false, error: "Bad request." };
  const what = kind === "beer" ? "beer" : field;

  const m = String(req.date || "").match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  const mon = m ? MONTHS.indexOf(m[1]) : -1;
  if (mon < 0) return { ok: false, error: "Bad game date." };
  const day = +m[2], year = +m[3];
  if (day < 1 || day > 31) return { ok: false, error: "Bad game date." };
  const ymd = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = todayYmd();
  if (Math.abs(year - +today.slice(0, 4)) > 1) return { ok: false, error: "Bad game date." };
  const sched = await schedule();
  const seasons = sched.seasons || {};
  const seasonKey = String(req.seasonKey || "");
  const picked = seasonKey && seasons[seasonKey] ? [seasons[seasonKey]] : Object.values(seasons);
  const game = picked.flatMap((s) => s.games || []).find((g) => g.date === `${m[1]} ${day}`);
  if (!game) return { ok: false, error: "That game isn't on the schedule." };
  const played = game.us != null;
  if (kind === "beer" && (ymd < today || played)) return { ok: false, error: "That game has already been played." };
  if (kind !== "beer" && ymd > today) return { ok: false, error: "That game hasn't been played yet." };

  const seasonHeader = String(req.seasonHeader || "").trim();
  const players = await atList(env, AT_ROSTER);
  if (!seasonHeader || !players.some((p) => seasonHeader in (p.fields || {}))) {
    return { ok: false, error: "There's no team list for that season yet." };
  }
  const player = players.find((p) => ON_TEAM.includes(norm((p.fields || {})[seasonHeader])) && norm(playerName(p)) === norm(req.name));
  if (!player) return { ok: false, error: "Only players on this season's team can be assigned beer." };
  const nameOf = {};
  for (const p of players) nameOf[p.id] = playerName(p);

  // One write per game at a time, so two taps can't both fill the same empty cell
  const lockKey = "lock:assign:" + ymd;
  if (await env.SC_KV.get(lockKey)) return { ok: false, error: "Someone else is assigning this game. Try again in a moment." };
  await env.SC_KV.put(lockKey, "1", { expirationTtl: 60 });
  try {
    const existing = await atList(env, AT_GAMES, { filterByFormula: `DATETIME_FORMAT({${F.date}},'YYYY-MM-DD')='${ymd}'` });
    if (existing.length) {
      const row = existing[0];
      const current = ((row.fields || {})[field] || []).map((id) => nameOf[id] || "").join(", ");
      if (current) return { ok: false, taken: current, error: `${current} already has ${what} for this game.` };
      await at(env, `${AT_BASE}/${AT_GAMES}`, { method: "PATCH",
        body: JSON.stringify({ records: [{ id: row.id, fields: { [field]: [player.id] } }] }) });
    } else {
      const fields = {
        [F.date]: ymd,
        [F.type]: game.opponent === "TBD" ? "Playoffs" : "Regular Season",
        [F.opponent]: game.opponent === "TBD" ? "" : String(game.opponent || ""),
        [field]: [player.id],
      };
      if (SEASON_NAMES.includes(req.season)) fields[F.season] = req.season;
      await at(env, `${AT_BASE}/${AT_GAMES}`, { method: "POST", body: JSON.stringify({ records: [{ fields }] }) });
    }
  } finally {
    await env.SC_KV.delete(lockKey);
  }
  return { ok: true, name: playerName(player), date: req.date, award: kind === "beer" ? undefined : kind };
}

/* ---------------- the cached copies ---------------- */

// Write a cache copy only when it changed; returns the copy now in KV
async function saveCopy(env, key, fields) {
  const old = await env.SC_KV.get(key, "json");
  const same = old && JSON.stringify(Object.assign({}, old, { at: 0 })) === JSON.stringify(Object.assign({}, fields, { at: 0 }));
  const copy = Object.assign({}, fields, { at: Date.now() });
  if (same) copy.at = Math.max(old.at || 0, copy.at);
  await env.SC_KV.put(key, JSON.stringify(copy));
  return copy;
}

async function refreshRoster(env) {
  return saveCopy(env, "cache:roster2", await fetchRoster(env));
}

// force re-reads the field list too, so ?fresh=1 picks up a season or year JP just added
async function refreshPublic(env, force) {
  const data = await fetchPublic(env, force);
  // Never cache an empty roster, whatever Airtable answered
  if (data.roster.length <= GRID.headerRow + 1) throw new Error("airtable returned no players");
  return saveCopy(env, "cache:public", { data });
}

// Read a cache copy, refreshing it first when `stale(age)` says so. A copy past its age is answered
// with straight away and refreshed behind the response (needs ctx). A failed refresh falls back to
// the copy we have; only a cold cache with Airtable down is an error.
async function cached(env, key, refresh, stale, maxAge, ctx) {
  const copy = await env.SC_KV.get(key, "json");
  const age = copy ? Date.now() - (copy.at || 0) : Infinity;
  if (copy && !stale(age)) return { copy, fresh: false };
  if (copy && ctx && age > maxAge) {
    ctx.waitUntil(refresh(env).catch((e) => console.error(key, "refresh", String(e))));
    return { copy, fresh: false };
  }
  try {
    return { copy: await refresh(env), fresh: true };
  } catch (e) {
    if (!copy) throw e;
    console.error(key, "refresh failed, using the copy from", Math.round(age / 1000), "s ago:", String(e));
    return { copy, fresh: false };
  }
}

// Served from KV so a page load never waits on Airtable. fresh=1 (the page checking whether an
// assignment landed, or JP nudging the site after editing the base) re-reads at most once a minute.
async function publicData(env, ctx, fresh) {
  const { copy } = await cached(env, "cache:public", fresh ? (e) => refreshPublic(e, true) : refreshPublic,
    (age) => (fresh ? age > RECHECK_MS : age > PUBLIC_MAX_AGE_MS), PUBLIC_MAX_AGE_MS, fresh ? null : ctx);
  return copy.data;
}

// {emails, names, fresh}. recheck asks for a read newer than RECHECK_MS, for an email JP may
// have just added to the roster.
async function roster(env, recheck) {
  const { copy, fresh } = await cached(env, "cache:roster2", refreshRoster,
    (age) => (recheck ? age > RECHECK_MS : age > ROSTER_MAX_AGE_MS), ROSTER_MAX_AGE_MS, null);
  return { emails: copy.emails || {}, names: copy.names || [], fresh };
}

async function nameForEmail(env, email) {
  const r = await roster(env, false);
  if (r.emails[email]) return r.emails[email];
  if (r.fresh) return "";
  return (await roster(env, true)).emails[email] || "";
}

async function isRosterName(env, name) {
  const r = await roster(env, false);
  if (r.names.includes(name)) return true;
  if (r.fresh) return false;
  return (await roster(env, true)).names.includes(name);
}

/* ---------------- the schedule ---------------- */

async function schedule() {
  const r = await fetch(SCHEDULE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error("schedule.json " + r.status);
  return r.json();
}

// "Sep 22, 2026" (or "Oct 22, 2026 · rontoberfest" for an entry sharing its date with another)
// in a posted season, unplayed, today or later -> {date, ymd, slug}
async function gameCheck(season, date) {
  const m = date.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: · (.+))?$/);
  const mon = m ? MONTHS.indexOf(m[1]) : -1;
  if (mon < 0) return { error: "Bad game date." };
  const day = +m[2], year = +m[3], slug = m[4] || "";
  const ymd = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = todayYmd();
  if (Math.abs(year - +today.slice(0, 4)) > 1) return { error: "Bad game date." };
  if (ymd < today) return { error: "That game has already been played." };
  const sched = await schedule();
  const games = (sched.seasons && sched.seasons[season] && sched.seasons[season].games) || [];
  const plain = `${m[1]} ${day}`;
  // Most dates hold one entry; when two share a date (an event alongside a game), the slug picks
  // one, and an unslugged request lands on the plain one (a game never carries a slug itself)
  const matches = games.filter((g) => g.date === plain);
  const game = matches.length <= 1 ? matches[0] : matches.find((g) => (g.slug || "") === slug);
  if (!game) return { error: "That game isn't on the schedule." };
  if (game.us != null) return { error: "That game has already been played." };
  const label = game.slug ? `${plain}, ${year} · ${game.slug}` : `${plain}, ${year}`;
  return { date: label, ymd, slug: game.slug || "" };
}

function todayYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const get = (t) => parts.find((x) => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/* ---------------- the calendar feed (GET /schedule.ics) ---------------- */

// "Sep 10" in a season -> the calendar year it falls in, from SEASON_YEARS: Aug through Dec is the
// season's first year, Jan onward its second (a one-year season, like a summer, has only the one)
function seasonYear(seasonKey, dateStr) {
  const ys = SEASON_YEARS[seasonKey];
  if (!ys) return null;
  if (ys.length < 2) return ys[0];
  return ["Aug", "Sep", "Oct", "Nov", "Dec"].includes(String(dateStr).split(" ")[0]) ? ys[0] : ys[1];
}

// A wall-clock time in America/New_York -> the matching UTC Date. No DST table of our own: convert
// once assuming UTC, see what that instant reads as in New York, and correct by the difference. That
// difference is the zone's real offset for that date (from the runtime's own tzdata), DST included.
function nyToUTC(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = {};
  for (const part of fmt.formatToParts(guess)) p[part.type] = part.value;
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === "24" ? 0 : +p.hour, +p.minute);
  return new Date(guess + (guess - shown));
}

function icsUTC(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function icsDate(y, mo, d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${y}${p(mo)}${p(d)}`;
}
// RFC 5545 escaping for a TEXT value: backslash, semicolon and comma are escaped, a real newline
// becomes the two characters \n (calendar apps turn that back into a line break on their side)
function icsEscape(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
// RFC 5545 line folding: no content line over 75 octets; a continuation line starts with a space
function icsFold(line) {
  const max = 75;
  if (line.length <= max) return line;
  let out = line.slice(0, max), rest = line.slice(max);
  while (rest.length) { out += "\r\n " + rest.slice(0, max - 1); rest = rest.slice(max - 1); }
  return out;
}
function icsLine(name, value) { return icsFold(`${name}:${value}`); }

// "David Sanders" -> "Sanders": the name the site's Beer column shows, from the roster grid /public
// builds. A nickname wins; otherwise the first name, with a last initial only when it would be
// ambiguous against the current team (the same rule as shortNames in index.html)
function beerNamer(rosterRows) {
  const rows = rosterRows || [];
  const head = rows[GRID.headerRow] || [];
  const iF = head.indexOf(F.first), iL = head.indexOf(F.last), iN = head.indexOf(F.nickname);
  const rank = (h) => {
    const m = h.match(/^(\w+),\s*(\d{2})/);
    return m ? +m[2] * 10 + ["Spring", "Summer", "Fall", "Winter"].indexOf(m[1]) : -1;
  };
  // The newest season with anyone on it: a column JP sets up ahead of time stays empty until then
  const staffed = (i) => rows.slice(GRID.headerRow + 1).some((row) => ON_TEAM.includes(norm((row || [])[i])));
  const seasonCols = head.map((h, i) => [h, i]).filter(([h, i]) => SEASON_RE.test(h) && staffed(i))
    .sort((a, b) => rank(b[0]) - rank(a[0]));
  const iS = seasonCols.length ? seasonCols[0][1] : -1;
  const nick = {}, onTeam = new Set(), all = [];
  for (let r = GRID.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const full = `${row[iF] || ""} ${row[iL] || ""}`.replace(/\s+/g, " ").trim();
    if (!full) continue;
    all.push(full);
    if (iN >= 0 && row[iN]) nick[norm(full)] = row[iN];
    if (iS >= 0 && ON_TEAM.includes(norm(row[iS]))) onTeam.add(norm(full));
  }
  const first = (n) => n.split(" ")[0].toLowerCase();
  const teamCount = {}, offCount = {};
  for (const n of all) {
    if (nick[norm(n)]) continue;
    const c = onTeam.has(norm(n)) ? teamCount : offCount;
    c[first(n)] = (c[first(n)] || 0) + 1;
  }
  return (full) => {
    const n = String(full || "").replace(/\s+/g, " ").trim();
    if (!n || nick[norm(n)]) return nick[norm(n)] || n;
    const k = first(n), parts = n.split(" ");
    const clash = onTeam.has(norm(n)) ? (teamCount[k] || 0) > 1 : (teamCount[k] || 0) > 0 || (offCount[k] || 0) > 1;
    return clash && parts[1] ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
  };
}

// Beer Duty by date ("Sep 10, 2026" -> short name), from the same grids /public builds; skips
// silently if the shape ever changes, since a feed with no beer notes still beats no feed
function beerByDate(scheduleRows, name = (n) => n) {
  const map = {};
  const rows = scheduleRows || [];
  const head = rows[0] || [];
  const iD = head.indexOf("Date"), iB = head.indexOf("Beer Duty");
  if (iD < 0 || iB < 0) return map;
  for (let i = 1; i < rows.length; i++) {
    const full = (rows[i][iB] || "").trim(), ds = (rows[i][iD] || "").trim();
    if (full && ds) map[ds] = name(full);
  }
  return map;
}

// Every season in schedule.json as one VCALENDAR: a game with a time gets an hour-long slot (the
// league's ice time; schedule.json doesn't carry an end time), an event with none (Rontoberfest) is
// an all-day entry. UID is stable across regenerations (season + date + slug) so a calendar app
// updates the same entry on refetch instead of duplicating it.
function buildScheduleIcs(sched, beerMap) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Scrub Club Hockey//Schedule//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    icsLine("X-WR-CALNAME", "Scrub Club Hockey"),
    icsLine("X-WR-CALDESC", "Scrub Club's game schedule, from scrubclubhockeyteam.com"),
    "X-WR-TIMEZONE:America/New_York",
  ];
  const seasons = sched.seasons || {};
  for (const seasonKey of Object.keys(seasons)) {
    for (const g of (seasons[seasonKey] || {}).games || []) {
      const year = seasonYear(seasonKey, g.date);
      const m = String(g.date || "").match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
      if (!year || !m) continue; // an unrecognized season key or a date we can't parse: skip it
      const mon = MONTHS.indexOf(m[1]) + 1;
      if (mon < 1) continue;
      const day = +m[2];
      const dateLabel = `${m[1]} ${day}, ${year}`;
      const uid = `${seasonKey}-${year}${String(mon).padStart(2, "0")}${String(day).padStart(2, "0")}` +
        `${g.slug ? "-" + g.slug : ""}@scrubclubhockeyteam.com`;

      const desc = [];
      if (g.us != null && g.them != null) {
        desc.push(`Final: ${g.us > g.them ? "W" : g.us < g.them ? "L" : "T"} ${g.us}-${g.them}`);
      }
      const beer = beerMap[dateLabel];
      if (beer) desc.push(`Beer: ${beer}`);
      desc.push("Full schedule: https://scrubclubhockeyteam.com/schedule/");

      lines.push("BEGIN:VEVENT");
      lines.push(icsLine("UID", uid));
      lines.push(icsLine("DTSTAMP", icsUTC(new Date())));
      const t = g.time ? String(g.time).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i) : null;
      if (t) {
        let hour = (+t[1]) % 12;
        if (/pm/i.test(t[3])) hour += 12;
        const start = nyToUTC(year, mon, day, hour, +t[2]);
        lines.push(icsLine("DTSTART", icsUTC(start)));
        lines.push(icsLine("DTEND", icsUTC(new Date(start.getTime() + 60 * 60 * 1000))));
      } else {
        const end = new Date(Date.UTC(year, mon - 1, day + 1));
        lines.push(`DTSTART;VALUE=DATE:${icsDate(year, mon, day)}`);
        lines.push(`DTEND;VALUE=DATE:${icsDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate())}`);
      }
      lines.push(icsLine("SUMMARY", icsEscape(g.event ? g.opponent : `vs. ${g.opponent}`)));
      if (g.rink) lines.push(icsLine("LOCATION", icsEscape(g.rink)));
      lines.push(icsLine("DESCRIPTION", icsEscape(desc.join("\n"))));
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function icsResponse(text) {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=1800",
      // "inline", not "attachment": a browser or OS that hands this to a calendar app still can;
      // this only names the file for whoever ends up saving it (JP, Sep 22, 2026)
      "Content-Disposition": 'inline; filename="scrub-club-hockey-schedule.ics"',
    },
  });
}

/* ---------------- answers ---------------- */

async function answersFor(env, season) {
  const games = {};
  let cursor;
  do {
    const page = await env.SC_KV.list({ prefix: `rsvp:${season}:`, cursor });
    for (const k of page.keys) {
      const md = k.metadata || {};
      const name = k.name.split(":").slice(3).join(":");
      if (!md.d || !name || !["in", "out"].includes(md.a)) continue;
      (games[md.d] = games[md.d] || {})[name] = { a: md.a, t: md.t || 0 };
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return games;
}

/* ---------------- email ---------------- */

async function sendMail(env, to, subject, text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return env.EMAIL.send({
    to,
    from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || "Scrub Club Hockey" },
    subject,
    text,
    html: "<p style=\"font:15px/1.6 -apple-system,sans-serif\">" +
          esc(text).replace(/\n\n/g, "</p><p style=\"font:15px/1.6 -apple-system,sans-serif\">")
                   .replace(/\n/g, "<br>") + "</p>",
  });
}

/* ---------------- small helpers ---------------- */

async function codeHash(code, email) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(code + ":" + email));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// KV-counter rate limit; races don't matter at team scale
async function overLimit(env, key, max, ttl) {
  const k = "rl:" + key;
  const n = parseInt((await env.SC_KV.get(k)) || "0", 10);
  if (n >= max) return true;
  await env.SC_KV.put(k, String(n + 1), { expirationTtl: ttl });
  return false;
}

async function refund(env, key) {
  const k = "rl:" + key;
  const n = parseInt((await env.SC_KV.get(k)) || "0", 10);
  if (n > 0) await env.SC_KV.put(k, String(n - 1), { expirationTtl: 3600 });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
function normEmail(s) { return String(s || "").trim().toLowerCase(); }
function emailish(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

async function readJson(request) {
  try { const b = await request.json(); return b && typeof b === "object" ? b : {}; }
  catch (_) { return {}; }
}

function corsHeaders(origin) {
  const allow = ORIGINS.includes(origin) ? origin : ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers),
  });
}
