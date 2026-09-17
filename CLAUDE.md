# scrubclubhockeyteam.com (Scrub Club)

Beer-league hockey team site. Static SPA, design tokens inline in index.html (burgundy/oatmeal, Graduate/Archivo/Big Shoulders).

## Deploy

GitHub Pages from `jpcoakley/scrub-club`. **Pushing to main is what deploys.**

Local preview: Google Drive paths are blocked for the preview server, so serve a copy from the session scratchpad.

1. `rsync -a --delete --exclude .git ./ <scratchpad>/site/` (re-run after every edit; run `sync-routes.sh` first if index.html changed).
2. `python3 -m http.server --directory ...` fails at startup (`PermissionError` from `os.getcwd()`, because the launch cwd is on Drive). Write `<scratchpad>/serve.py` instead, which changes directory before serving:
   ```python
   import os, sys, http.server, functools
   d=sys.argv[1]; os.chdir(d)
   http.server.ThreadingHTTPServer(("127.0.0.1",8471), functools.partial(http.server.SimpleHTTPRequestHandler, directory=d)).serve_forever()
   ```
3. The launch entry is `scrub-club-site` in `Hockey/Claude/.claude/launch.json` (the parent folder, not this repo): `"runtimeExecutable": "python3"`, `"runtimeArgs": ["<scratchpad>/serve.py", "<scratchpad>/site"]`, `"port": 8471`. The scratchpad path changes every session, so update both args, then `preview_start` with that name.

The console shows harmless 404s for `/team/stats.json`; the page falls back to `/stats.json`.

## Rules

- **Never use em dashes** in any copy.
- Current logo is the **foam soap bar** (`soap-logo.png`). The pink sticker soap and the rainbow circle are old; do not use them.
- The Swag tab is a hand-maintained gallery of `.swag-card`s linking to the Printful Quick Store (https://scrubclubhockeyteam.printful.me). Products are created in Printful, then added here by hand.
- Roster, dues, and season data live in the Scrub Club Roster Google Sheet, not in this repo. Dues collection runs through the `collect-dues` skill; its status column rules are sacred.
- Schedule renders `schedule.json` and Team renders `stats.json` (Stats was folded into Team; `/stats/` still routes there), weekly GameSheet snapshots taken by the `scrub-club-schedule-refresh` scheduled task. GameSheet sits behind a Cloudflare bot check: curl gets 403, only the in-app Browser works, and the "Verify you are human" box is never clicked (it clears on its own with the tab fronted). Team pages: `/seasons/<season>/teams/<team>/team-stats` renders two tables; `scripts/gamesheet-stats.js` turns them into a season's stats.json entry.
- GameSheet JSON API: once a gamesheetstats.com tab has cleared the bot check, the page can fetch same-origin JSON through `javascript_tool` (top-level `await` works). Use it for games instead of reading the rendered games list, which is virtualized and renders as a table (not `.bracket-card` cards) at wide viewports.
  - `/api/leagues/1147759/seasons`: the league's active seasons with their ids (league 1147759 is Ice Pack Hockey).
  - `/api/unified-games/<season>?order=asc&limit=300&offset=0`: every game in the season. Each item in `data` has number, date ("Sep 10, 2026"), time, location ("Rink 2"), status ("final" or "scheduled"), gameType, and visitor/home objects with title and goals. `meta.total` is the game count. The payload is large, so map it to compact fields inside the javascript call.
  - Our team titles are schedule.json's `teamAliases`; Winter 2026-27 is season 15842, team 553772 ("Scrub Club (WHT)").
- stats.json names are GameSheet's short form ("D. Sanders"). index.html joins them to the roster sheet by last name, initial and jersey; `GS_ALIASES` pins the ones that can't be settled. The Beer column counts that season's runs in the sheet's Beer log.
- Schedule Beer Man assignments: the Assign button in an empty Beer Man cell opens a pick list of that season's team (statuses In, Paid, Half, Goalie in the season's status column; `ON_TEAM` in index.html) and posts to `apps-script/beer-request.gs`, deployed as a web app from the roster sheet. Its URL goes in `BEER_REQUEST_URL` in index.html (empty hides the buttons). The script re-checks team status against the rightmost roster column headed with the season (`seasonHeader`), only accepts unplayed games with no Beer Man yet, and writes Beer Duty on the sheet's Schedule tab. Keep its `ON_TEAM` in step with index.html. Editing the script means redeploying it in Apps Script (Manage deployments, edit, New version) so the URL stays the same.
- Team letters: `CAPTAINS` (C: David Sanders) and `ALTERNATES` (A: Adam Davis; Fred Small from Winter 2026-27) in index.html's CONFIG, as `{name, from}` where `from` is the first SEASONS key the letter applies to (omit for every season). Names must match the roster sheet's First + Last exactly.
- **In/Out** (Schedule tab, since Sep 17, 2026): every upcoming game has In / Out buttons and a "N in · N out" count that opens the names (In, Out, and "No answer" = that season's team from the sheet). Backed by the Cloudflare Worker in `worker/` at **api.scrubclubhockeyteam.com** (`RSVP_API` in index.html; empty hides the column). Deploy it with `cd worker && npx wrangler deploy` (separate from the GitHub Pages site). Sign-in is a six-digit code emailed to the address in the roster sheet's **Email** column (plus `EXTRA_EMAILS` in worker.js for JP); the sheet is the allowlist, and clearing an email signs that person out within five minutes. Codes go out from `MAIL_FROM` in worker/wrangler.toml, on the account's verified sending domain (familytree.jpcoakley.com); to send from scrubclubhockeyteam.com, add that domain under Email Service in the Cloudflare dashboard and change the var. Answers are KV keys `rsvp:<season key>:<yyyy-mm-dd>:<name>` with the answer in metadata, so a season reads back in one list call; a fresh write can take up to a minute to show in that list, which is why the page updates itself from the POST reply. The session token lives in localStorage (`scrub.session`) for a year. Only unplayed games on schedule.json that are today or later (Eastern) accept answers. Inspect answers: `npx wrangler kv key list --namespace-id 1ed90cad12c94c33917afab4fd90716f --prefix rsvp: --remote`.
