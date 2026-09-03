# scrubclubhockeyteam.com (Scrub Club)

Beer-league hockey team site. Static SPA, design tokens inline in index.html (burgundy/oatmeal, Graduate/Archivo/Big Shoulders).

## Deploy

GitHub Pages from `jpcoakley/scrub-club`. **Pushing to main is what deploys.**

Local preview: Google Drive paths are blocked for the preview server. Rsync the site to the session scratchpad and serve from there (`.claude/launch.json` `scrub-club` entry; update its scratchpad path per session).

## Rules

- **Never use em dashes** in any copy.
- Current logo is the **foam soap bar** (`soap-logo.png`). The pink sticker soap and the rainbow circle are old; do not use them.
- The Swag tab is a hand-maintained gallery of `.swag-card`s linking to the Printful Quick Store (https://scrubclubhockeyteam.printful.me). Products are created in Printful, then added here by hand.
- Roster, dues, and season data live in the Scrub Club Roster Google Sheet, not in this repo. Dues collection runs through the `collect-dues` skill; its status column rules are sacred.
- Schedule and Stats render `schedule.json` and `stats.json`, weekly GameSheet snapshots taken by the `scrub-club-schedule-refresh` scheduled task. GameSheet sits behind a Cloudflare bot check: curl gets 403, only the in-app Browser works, and the "Verify you are human" box is never clicked (it clears on its own with the tab fronted). Team pages: `/seasons/<season>/teams/<team>/team-stats` renders two tables; `scripts/gamesheet-stats.js` turns them into a season's stats.json entry.
- stats.json names are GameSheet's short form ("D. Sanders"). index.html joins them to the roster sheet by last name, initial and jersey; `GS_ALIASES` pins the ones that can't be settled. The Beer column counts that season's runs in the sheet's Beer log.
