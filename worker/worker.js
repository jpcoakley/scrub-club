/* Scrub Club In/Out: api.scrubclubhockeyteam.com
 *
 * Players say whether they're coming to each upcoming game. Sign-in is a
 * six-digit code emailed to the address on their row of the Scrub Club
 * Roster sheet, so nobody can answer for anyone else and there is no
 * password to forget. The roster sheet is the allowlist: to let someone
 * sign in, put their email in the Email column of their row; to lock them
 * out, clear it (their session stops working within five minutes).
 *
 *   GET  /                  greeting
 *   POST /auth/start        {email}        emails a code if the email is on the roster
 *   POST /auth/verify       {email, code}  -> {token, name}; the token is a Bearer token
 *   GET  /me                Bearer         -> {name, email}
 *   POST /auth/signout      Bearer         drops the session
 *   GET  /rsvp?season=W                    -> {games: {"Sep 22, 2026": {"JP Coakley": {a, t}}}}
 *   POST /rsvp              Bearer, {season, date, answer: "in" | "out" | "", name?}
 *                           name = a teammate on the sheet, to answer for them
 *                           (the answer then carries who set it, in `by`)
 *
 * Storage (KV):
 *   sess:<token>            {email, at, renewed}              a year, renewed weekly by /me
 *   otp:<email>             {hash, tries}                     10 minutes
 *   rl:<what>:<who>         counter                           rate limits
 *   cache:roster2           {emails: {email: name}, names}    5 minutes
 *   rsvp:<season>:<ymd>:<name>   value "in" | "out", metadata {a, t, d, by?}
 *
 * One key per player per game means two people tapping at once can't
 * overwrite each other, and a season's answers come back from one
 * list() call because the answer rides in the key's metadata.
 *
 * A game is only answerable while it is on schedule.json, unplayed, and
 * today or later (Eastern time).
 */

const SHEET_ID = "1nRKRkEoHEBUjb4c0mI8GQVk8riIwmDT_XBENtXcTwjg";
const ROSTER_GID = "901229563";
const ROSTER_HEADER_ROW = 7;
const SCHEDULE_URL = "https://scrubclubhockeyteam.com/schedule.json";
// Emails that sign in even when the sheet doesn't list them, and who they are
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

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("Origin") || "");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await route(request, env); }
    catch (e) {
      console.error("unhandled", String(e && e.stack || e));
      res = json({ ok: false, error: "Something went wrong. Try again." }, 500);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  if (m === "GET" && p === "/") return json({ ok: true, message: "Scrub Club In/Out is running." });

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
        "Your Scrub Club sign-in code is " + code + ". It works for the next 10 minutes.\n\n" +
        "If you didn't ask for it, you can ignore this email.");
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
    if (!name) return json({ ok: false, error: "That email isn't on the roster sheet any more." }, 403);
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

  // ---- who's in and out, one season at a time ----
  if (m === "GET" && p === "/rsvp") {
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
    // Anyone signed in can answer for a teammate; the sheet says who counts as one
    const name = String(body.name || "").replace(/\s+/g, " ").trim() || me.name;
    if (name !== me.name && !(await isRosterName(env, name))) {
      return json({ ok: false, error: "That name isn't on the roster sheet." }, 400);
    }
    const key = `rsvp:${season}:${game.ymd}:${name}`;
    if (answer) {
      const metadata = { a: answer, t: Date.now(), d: game.date };
      if (name !== me.name) metadata.by = me.name;
      await env.SC_KV.put(key, answer, { metadata });
    } else {
      await env.SC_KV.delete(key);
    }
    return json({ ok: true, season, date: game.date, name, answer, by: name !== me.name ? me.name : undefined });
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

// A live session whose email is still on the roster; the sheet can revoke anyone
async function whoami(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const sess = await env.SC_KV.get("sess:" + token, "json");
  if (!sess || !sess.email) return null;
  const name = await nameForEmail(env, sess.email);
  if (!name) return null;
  return { email: sess.email, name, token, at: sess.at || Date.now(), renewed: sess.renewed || 0 };
}

/* ---------------- the roster sheet ---------------- */

// email -> "First Last" from the Email column; the sheet is read through
// /export (the underlying data), never /gviz (whatever filter is on).
async function fetchRoster() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${ROSTER_GID}`;
  const r = await fetch(url, { cf: { cacheTtl: 0 }, redirect: "follow" });
  if (!r.ok) throw new Error("roster sheet " + r.status);
  const rows = parseCSV(await r.text());
  const head = (rows[ROSTER_HEADER_ROW - 1] || []).map((h) => String(h).trim());
  const iE = head.indexOf("Email"), iF = head.indexOf("First"), iL = head.indexOf("Last");
  if (iE < 0 || iF < 0 || iL < 0) throw new Error("roster sheet is missing Email, First or Last");
  const emails = {}, names = [];
  for (let i = ROSTER_HEADER_ROW; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = `${row[iF] || ""} ${row[iL] || ""}`.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (!names.includes(name)) names.push(name);
    // a cell may hold more than one address
    for (const e of String(row[iE] || "").split(/[\s,;]+/).map(normEmail).filter(emailish)) {
      if (!(e in emails)) emails[e] = name;
    }
  }
  for (const [e, n] of Object.entries(EXTRA_EMAILS)) {
    if (!(e in emails)) emails[e] = n;
    if (!names.includes(n)) names.push(n);
  }
  return { emails, names };
}

// {emails, names, cached}; the sheet is read at most every five minutes
async function roster(env, fresh) {
  if (!fresh) {
    const cached = await env.SC_KV.get("cache:roster2", "json");
    if (cached && cached.emails) return Object.assign(cached, { cached: true });
  }
  const r = await fetchRoster();
  await env.SC_KV.put("cache:roster2", JSON.stringify(r), { expirationTtl: 300 });
  return Object.assign(r, { cached: false });
}

// An email JP just added to the sheet shouldn't wait out the cache
async function nameForEmail(env, email) {
  const r = await roster(env, false);
  if (r.emails[email]) return r.emails[email];
  if (!r.cached) return "";
  return (await roster(env, true)).emails[email] || "";
}

async function isRosterName(env, name) {
  const r = await roster(env, false);
  if (r.names.includes(name)) return true;
  if (!r.cached) return false;
  return (await roster(env, true)).names.includes(name);
}

/* ---------------- the schedule ---------------- */

async function schedule() {
  const r = await fetch(SCHEDULE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error("schedule.json " + r.status);
  return r.json();
}

// "Sep 22, 2026" in a posted season, unplayed, today or later -> {date, ymd}
async function gameCheck(season, date) {
  const m = date.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  const mon = m ? MONTHS.indexOf(m[1]) : -1;
  if (mon < 0) return { error: "Bad game date." };
  const day = +m[2], year = +m[3];
  const ymd = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = todayYmd();
  if (Math.abs(year - +today.slice(0, 4)) > 1) return { error: "Bad game date." };
  if (ymd < today) return { error: "That game has already been played." };
  const sched = await schedule();
  const games = (sched.seasons && sched.seasons[season] && sched.seasons[season].games) || [];
  const game = games.find((g) => g.date === `${m[1]} ${day}`);
  if (!game) return { error: "That game isn't on the schedule." };
  if (game.us != null) return { error: "That game has already been played." };
  return { date: `${m[1]} ${day}, ${year}`, ymd };
}

function todayYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const get = (t) => parts.find((x) => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
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
      const v = { a: md.a, t: md.t || 0 };
      if (md.by) v.by = md.by;
      (games[md.d] = games[md.d] || {})[name] = v;
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

// Minimal RFC-4180 CSV parser (quoted fields, embedded commas and newlines)
function parseCSV(text) {
  const rows = [[]]; let field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { rows[rows.length - 1].push(field); field = ""; }
    else if (ch === "\n") { rows[rows.length - 1].push(field); field = ""; rows.push([]); }
    else if (ch !== "\r") field += ch;
  }
  rows[rows.length - 1].push(field);
  if (rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}
