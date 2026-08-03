#!/bin/sh
# Copy index.html into each section folder so /about/, /team/, etc. serve the app.
# Run after any edit to index.html, before committing.
cd "$(dirname "$0")"
for r in about team schedule stats swag join; do
  mkdir -p "$r"
  cp index.html "$r/index.html"
done
echo "routes synced: about team schedule stats swag join"
