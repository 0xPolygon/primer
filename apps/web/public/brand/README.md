# Polygon brand assets for published artifacts

Served at `/brand/...` on the app origin so uploaded artifacts (gambit
decks, solution docs) can reference fonts under the artifact CSP's
`font-src 'self'` and art under `img-src https:` without embedding
hundreds of KB of base64 that cannot pass through the MCP upload path.

Source of truth: the gambit repo, `skill/assets/` (fonts: PolySans
woff2 trio; art: hex webp extractions listed in
`skill/assets/art/manifest.json`). Filenames are a public contract —
gambit's `brand.py --publish` build derives URLs from them. Update both
repos together or not at all.
