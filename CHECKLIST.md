# scrubclubhockeyteam.com checklist

From The AI Folder digest (`docs/ai-folder-digest.md` in the jpcoakley.com repo). State checked against this repo on 3 September 2026: `[x]` is already true in the code, `[ ]` is open. Not committed by Claude; the repo is public and GitHub Pages serves every committed file.

Stack: static site on GitHub Pages (repo jpcoakley/scrub-club) with SPA-style routes. Roster and schedule come from the Google Sheet as CSV exports. The swag store is Printful's hosted Quick Store, so checkout and payments never touch this site. Dues are collected by Venmo request.

## Before you publish

- [x] Open Graph image, meta description, favicon and Apple touch icon on index.html.
- [ ] Meta description on the second root page (it has none).
- [ ] robots.txt and sitemap.xml listing the real routes, then Search Console.
- [ ] A branded 404.html; GitHub Pages picks it up, and it can carry the SPA route handling too.
- [ ] Analytics: none installed.
- [ ] Alt text on player photos and the logo.
- [ ] Loading and error states for the sheet fetch: when the CSV fails or is slow, say so instead of an empty roster.
- [ ] Real contact information (an email for prospective players, not just a form or social link).
- [ ] Call to action above the fold: join or schedule, and the swag store link visible on a phone.
- [x] Static HTML, indexable as built.
- [x] In GitHub, deploys from main.
- Not applicable: app subdomain, transactional email (Printful and Venmo send their own).

## Security

- No backend here. Two things still matter:
- [ ] The published sheet tab is public. Keep phone numbers, emails, dues and anything personal off the tab that feeds the site, and check that hidden columns are not in the export (`/export?format=csv` returns them).
- [ ] Do not hotlink Printful mockups from a token-bearing URL; keep copies in the repo as already practised.

## Legal and trust

- [ ] A short privacy line: the roster shows teammates' names and photos; note that anyone can ask to be removed, and ask new players before adding their photo.
- [x] No cookie banner needed while there is no analytics.
- [x] Payments, refunds and terms are Printful's on their hosted store.
- Not applicable: testimonials, subscriptions.

## Design

- [ ] Icon audit (share, menu, calendar).
- [ ] DESIGN.md at the repo root (the foam-soap logo, colours, type) so Claude stays consistent.
- [ ] Try realtimecolors.com before any palette change.

## Working with Claude here

- [x] collect-dues skill, roster sheet rules (status column is sacred).
- [ ] Routine: after each game week, confirm the schedule and stats snapshots refreshed.
- [ ] Run the official Claude Code Setup plugin once.
