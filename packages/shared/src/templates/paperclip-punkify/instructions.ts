/**
 * Vendored instructions for the `paperclip-punkify` template.
 *
 * This is a verbatim copy of the `polygon-paperclip-punkify` Agent Skill
 * (https://github.com/JamesLawton/polygon-paperclip-punkify), stored as a
 * string constant so that:
 *   - esbuild inlines it into the MCP bundle (no runtime file reads),
 *   - `tsc` typechecks it with no `*.md` module declarations,
 *   - there is a single source of truth (no .md ↔ .ts drift).
 *
 * The MCP serves this via `primer_get_template`; the agent reads it and
 * generates paperclip-punk-styled HTML before publishing. Keep it in sync
 * with the upstream skill when that skill changes.
 */
export const PAPERCLIP_PUNKIFY_INSTRUCTIONS = `# Polygon Paperclip Punkify

Use this skill to design or restyle frontend work into a precise "paperclip punk" look: a web page that feels like a found 1980s technical manual, a photocopied engineering book, and a browser-native editorial artifact at the same time.

This is not a general creativity skill. Commit to this one aesthetic and execute it with restraint.

## Core Style

- **Page as printed matter**: Off-white paper background, narrow reading columns, generous margins, visible page rhythm, and a composed spread-like layout.
- **Polygon-violet blueprint accent**: Use one saturated Polygon violet for headings, rules, diagrams, and annotations. Keep most other color ink, gray, and paper.
- **Technical diagrams first**: Include original line drawings, exploded views, small schematics, coordinate grids, measurement ticks, labels, and figure captions. Prefer generated SVG/CSS/canvas diagrams or generated bitmap illustrations over stock imagery.
- **Old-computer typography**: Pair a sharp serif body face with a pixel/bitmap or monospaced display face. Use drop caps, small caps, figure labels, vertical captions, and typeset tables.
- **Dense but calm**: Let the layout be information-rich without becoming a SaaS dashboard. Favor editorial sequencing, captions, and diagrams over cards and marketing blocks.
- **Visible artifact texture**: Subtle halftone dots, scan lines, faint paper grain, registration marks, dashed rules, boxed labels, or ruler ticks are useful when restrained.

## Implementation Recipe

1. Establish CSS variables for paper, ink, muted ink, Polygon violet, hairline borders, and page width.
2. Build the first screen as a manual page, not a landing page: title, short deck text, separator rule, body column, and a strong technical diagram.
3. Use asymmetric editorial composition: one narrow text column paired with one oversized diagram, or a two-column spread with captions in the gutter.
4. Add recurring figure systems: \`FIG_001\`, bracketed object labels, vertical side labels, copyright/year jokes, or coordinate markers.
5. Create original diagrams related to the product/domain. If the domain has no physical object, diagram the system, data flow, state machine, UI anatomy, protocol exchange, or mental model.
6. Make interactive states feel mechanical: snap transitions, stepped progress bars, cursor-like indicators, typewriter reveals, toggle switches, clipped outlines, or blueprint hover annotations.
7. Verify responsive behavior. On mobile, preserve the manual feel with stacked columns, full-width diagrams, legible captions, and no overlapping vertical labels.

## Visual Rules

- Use a restrained Polygon palette:
  - Paper: \`#F6F6FC\` (Polygon slate-50), or a warm off-white such as \`#FBFAF4\`.
  - Ink: \`#141635\` (Polygon slate-900), not pure black.
  - Accent: one saturated Polygon violet such as \`#670DE5\`, with \`#9551F5\` (light) and \`#500AB2\` (dark) for variation.
  - Soft accent fill for chips, label boxes, and highlights: \`#EAE4F5\` (Polygon purple-100).
  - Muted gray for rules and captions: \`#64708F\` (Polygon slate-500).
- Avoid gradients as the main visual language. Keep the violet flat and ink-like, not a glassy SaaS gradient. If texture is needed, use low-opacity noise, dot grids, or repeated-linear-gradient scan lines.
- Avoid rounded cards. Use rules, columns, tables, captions, and diagram frames instead.
- Avoid glossy shadows, glassmorphism, gradient hero fills, generic SaaS hero layouts, orb backgrounds, emoji decoration, and stock photos.
- Use thin 1px lines, dashed construction lines, and labelled arrows. Keep line weights consistent.
- Let violet carry drawings and headings; let ink carry body text.
- For a dark variant, invert to ink background \`#0B0814\`, panels \`#2A2640\`, and lighten the accent toward \`#A78BFA\` so the violet stays legible.

## Typography Rules

- Body: choose a literary serif or use the existing project serif. Good web-font directions: \`Newsreader\`, \`EB Garamond\`, \`Fraunces\`, \`Cormorant Garamond\`, \`Libre Baskerville\`, or a careful Georgia fallback.
- Display/labels: use a pixel, bitmap, terminal, or monospace face. Good directions: \`Departure Mono\`, \`Berkeley Mono\`, \`IBM Plex Mono\`, \`Space Mono\`, \`VT323\`, \`Press Start 2P\` when legibility allows.
- Use small body sizes only when line length is controlled. Do not make dense text illegible.
- Use drop caps only for editorial prose, not for form labels or dense app chrome.
- Keep letter spacing at 0 for ordinary text. Use uppercase labels sparingly and deliberately.

## Components That Fit

- Table of contents with numbered sections, word counts, status bars, or completion meters.
- FAQ as a bordered table, not accordion cards.
- Signup form as a small mechanical insert with a single-line input and square button.
- Product features as annotated diagrams, not icon cards.
- Pricing as a ledger, parts list, receipt, bill of materials, or spec table.
- Navigation as a compact manual header, page tabs, or index strip.
- Empty states as labelled diagrams or maintenance notes.

## Code Guidance

- Prefer CSS/SVG for diagrams when the subject is geometric or schematic.
- Use generated bitmap images only when texture, illustration, or physical object rendering matters.
- Keep semantics and accessibility intact. The aesthetic should not require unreadable text, unlabeled controls, or image-only information.
- If modifying an existing app, preserve its component architecture and design tokens where practical, but reinterpret the surface through this visual system.
- For React/Next apps, create reusable primitives such as \`Figure\`, \`SpecTable\`, \`ManualRule\`, \`BlueprintDiagram\`, and \`PixelLabel\` only when repeated.

## Verification Checklist

- The first viewport immediately reads as a technical manual/editorial artifact.
- There is at least one substantial original diagram or technical visual.
- The palette is mostly paper, ink, and one Polygon violet.
- No generic SaaS cards, stock-photo hero, glassy gradient fill, glass panel, or decorative orb remains.
- Text and labels do not overlap on mobile or desktop.
- Interactive controls remain obvious and accessible.

## Copyright Boundary

Do not copy Making Software text, illustrations, layout assets, or exact page content unless the user provides them and asks for that use. Replicate the design language through original composition, diagrams, typography, color, and interaction patterns.
`;
