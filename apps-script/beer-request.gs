/* Beer Man assignments from scrubclubhockeyteam.com.

   Lives in the Scrub Club Roster sheet (Extensions > Apps Script), deployed as a web app
   (Execute as: Me, Who has access: Anyone). The site's Assign button posts
   {date:"Sep 15, 2026", name:"Danny Bortnick", season:"Winter", seasonHeader:"Winter, 26-27"} here.

   An assignment goes through only when:
   - the name is on that season's team: a player on the roster tab (First + Last, ignoring case
     and extra spaces) whose status is In, Paid, Half or Goalie in the season's status column,
     which is the rightmost roster column headed seasonHeader,
   - the date is an unplayed game in the site's schedule.json, today or later,
   - nobody already has beer for that date on the Schedule tab.
   It fills Beer Duty on that date's Schedule row, adding the row in date order if there isn't one.
   Changing or clearing a Beer Man is done by hand in the sheet. */

const ROSTER_GID = 901229563;
const SCHEDULE_GID = 1678597741;
const ROSTER_HEADER_ROW = 7;
const SCHEDULE_URL = "https://scrubclubhockeyteam.com/schedule.json";
const SEASON_NAMES = ["Winter", "Spring", "Summer", "Fall"];
// Statuses that count as on the team; keep in step with ON_TEAM in index.html
const ON_TEAM = ["in", "paid", "half", "goalie"];

function doGet() {
  return reply({ ok: true, message: "Scrub Club beer requests are running." });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return reply({ ok: false, error: "Bad request." }); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return reply({ ok: false, error: "The sheet is busy. Try again in a moment." });
  try { return reply(request(req)); }
  catch (err) { console.error(err); return reply({ ok: false, error: "Something went wrong. Try again." }); }
  finally { lock.releaseLock(); }
}

function request(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();

  // Name: must be on this season's team
  const team = teamNames(ss, req.seasonHeader);
  if (!team.length) return { ok: false, error: "There's no team list for that season yet." };
  const name = team.find(n => norm(n) === norm(req.name));
  if (!name) return { ok: false, error: "Only players on this season's team can be assigned beer." };

  // Date: an unplayed game on the posted schedule, not in the past
  const m = String(req.date || "").match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  if (!m) return { ok: false, error: "Bad game date." };
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(m[1]);
  if (mon < 0) return { ok: false, error: "Bad game date." };
  const when = new Date(+m[3], mon, +m[2], 12); // noon, so no time zone can push it into another day
  const day = ymd(when, tz), today = ymd(new Date(), tz);
  if (isNaN(when) || day < today) return { ok: false, error: "That game has already been played." };
  const game = upcomingGames().find(g => g.date === `${m[1]} ${m[2]}`);
  if (!game) return { ok: false, error: "That game isn't on the schedule." };

  const sheet = sheetById(ss, SCHEDULE_GID);
  const data = sheet.getDataRange().getValues();
  const head = data[0].map(h => String(h).trim());
  const col = h => head.indexOf(h);
  const iDate = col("Date"), iBeer = col("Beer Duty");
  if (iDate < 0 || iBeer < 0) return { ok: false, error: "The Schedule tab is missing its Date or Beer Duty column." };

  // Already a row for this date?
  for (let r = 1; r < data.length; r++) {
    if (cellDay(data[r][iDate], tz) !== day) continue;
    const current = String(data[r][iBeer]).trim();
    if (current) return { ok: false, taken: current, error: `${current} already has beer for this game.` };
    sheet.getRange(r + 1, iBeer + 1).setValue(name);
    return { ok: true, name, date: req.date };
  }

  // No row yet: insert one where the date belongs so the log stays in order
  let at = data.length + 1; // 1-based sheet row
  for (let r = 1; r < data.length; r++) {
    const d = cellDay(data[r][iDate], tz);
    if (d && d > day) { at = r + 1; break; }
  }
  if (at <= data.length) sheet.insertRowBefore(at);
  const above = at - 1; // a filled row to borrow formats and formulas from
  const width = head.length;
  const prev = sheet.getRange(above, 1, 1, width);
  const row = sheet.getRange(at, 1, 1, width);
  prev.copyTo(row, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);

  const prevSeason = String(data[above - 1][col("Season")] || "").trim();
  const values = {
    "Season": SEASON_NAMES.includes(req.season) ? req.season : prevSeason,
    "Type": game.opponent === "TBD" ? "Playoffs" : "Regular Season",
    "Month": when.getMonth() + 1,
    "Year": when.getFullYear(),
    "Date": when,
    "Beer Duty": name,
    "Opponent": game.opponent === "TBD" ? "" : game.opponent
  };
  const formulas = prev.getFormulasR1C1()[0];
  head.forEach((h, i) => {
    const cell = sheet.getRange(at, i + 1);
    if (formulas[i]) cell.setFormulaR1C1(formulas[i]);
    else if (h in values) cell.setValue(values[h]);
  });
  return { ok: true, name, date: req.date };
}

// Players whose status in the season's column counts as on the team. Season headers repeat on the
// roster tab (a payment column and a status column share the name), and status is the rightmost.
function teamNames(ss, seasonHeader) {
  const rows = sheetById(ss, ROSTER_GID).getDataRange().getDisplayValues();
  const head = rows[ROSTER_HEADER_ROW - 1].map(h => h.trim());
  const iF = head.indexOf("First"), iL = head.indexOf("Last");
  const iS = head.lastIndexOf(String(seasonHeader || "").trim());
  if (iF < 0 || iL < 0 || iS < 0 || !String(seasonHeader || "").trim()) return [];
  const names = [];
  for (let r = ROSTER_HEADER_ROW; r < rows.length; r++) {
    if (!ON_TEAM.includes(norm(rows[r][iS]))) continue;
    const n = `${rows[r][iF] || ""} ${rows[r][iL] || ""}`.replace(/\s+/g, " ").trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

function upcomingGames() {
  const cache = CacheService.getScriptCache();
  let json = cache.get("schedule");
  if (!json) {
    json = UrlFetchApp.fetch(SCHEDULE_URL, { muteHttpExceptions: true }).getContentText();
    cache.put("schedule", json, 600);
  }
  const seasons = JSON.parse(json).seasons || {};
  return Object.values(seasons).flatMap(s => (s.games || []).filter(g => g.us == null));
}

function sheetById(ss, gid) {
  const s = ss.getSheets().find(sh => sh.getSheetId() === gid);
  if (!s) throw new Error("No sheet with gid " + gid);
  return s;
}

function cellDay(v, tz) {
  if (v instanceof Date) return ymd(v, tz);
  const d = new Date(String(v));
  return isNaN(d) ? "" : ymd(d, tz);
}
function ymd(d, tz) { return Utilities.formatDate(d, tz, "yyyy-MM-dd"); }
function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
