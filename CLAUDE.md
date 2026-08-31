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
