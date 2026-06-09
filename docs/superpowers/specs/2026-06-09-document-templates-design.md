# Primer document templates (skill-driven) — design

Date: 2026-06-09
Status: approved, implementing
Branch: `feat/document-templates`

## Problem

Primer publishes whatever HTML the agent generates. There is no first-class
notion of a *style template* the user can opt into, and no signal on the
rendered document about which aesthetic it was built with. We want a
template feature where the agent applies a named skill (first example:
`paperclip-punkify`) when creating or revising a document, and Primer
records and displays that choice.

## Approach

The template **is a vendored skill**. The mechanism:

```
agent calls primer_create_document({ title, content, template: 'paperclip-punkify' })
        │  (content is ALREADY styled — the agent read the skill's instructions
        │   via primer_get_template and generated paperclip-punk HTML itself)
        ▼
API validates the template id against the shared registry, persists it on the version row
        ▼
web renders a non-clickable badge in the document header for the viewed version
```

The server never styles anything. It records the tag and displays a badge.
This keeps the upload pipeline unchanged and fits "use skills the user
wants" — styling lives in the skill, which the agent runs.

### Decisions (from brainstorming)

- **Tag scope: per-version.** Revising = a new version, so each version
  records the template it was built with; the badge follows the viewed
  version. An older untemplated version shows no badge.
- **Badge: non-clickable chip in the document header**, next to the version
  selector — "at the top near the navbar" without overloading global nav.
- **Self-contained: vendored into Primer.** The skill instructions live in
  `@primer/shared` so both the API (validation) and MCP (serving
  instructions) read one registry. Installing the Primer plugin is enough;
  no separate `npx skills add`.

## Components

### 1. Template registry — `packages/shared/src/templates/`

```
templates/
  index.ts                       # Template types, TEMPLATES catalog, helpers
  paperclip-punkify/
    instructions.ts              # vendored paperclip-punkify SKILL.md text (string const)
```

> Implementation note: the approved sketch showed a `template.json` +
> `SKILL.md`. We vendor the instructions as a **TypeScript string module**
> instead, because (a) esbuild already bundles `@primer/shared` into the MCP
> with no extra loader, (b) `tsc` typechecks it with no `*.md`/JSON module
> declarations, and (c) it keeps a single source of truth (no .md↔.ts
> drift). Metadata stays as a typed object in `index.ts`. Net effect for the
> user is identical: one self-contained folder per template, served by the
> MCP.

`index.ts` exports:

- `interface Template { id; label; description; color; skillName; instructions }`
- `interface TemplateSummary { id; label; description }` (discovery — no heavy instructions)
- `interface DocumentTemplate { id; label; color }` (the API/web DTO)
- `TEMPLATES: Record<string, Template>`
- `listTemplates(): TemplateSummary[]`
- `getTemplate(id): Template | undefined`
- `isValidTemplateId(id): boolean`
- `resolveDocumentTemplate(id: string | null): DocumentTemplate | null`
  (resolves a stored id to its current label/color; unknown id → null)

`paperclip-punkify` metadata: `id: "paperclip-punkify"`, `label: "Paperclip
Punk"`, `color: "#670DE5"` (Polygon violet), `skillName:
"polygon-paperclip-punkify"`.

Re-exported from `packages/shared/src/index.ts` and via a `./templates`
subpath in the package `exports` map.

### 2. MCP surface — `apps/mcp`

- `primer_list_templates` → `{ templates: TemplateSummary[] }`. Reads the
  registry from `@primer/shared` directly (no API round-trip).
- `primer_get_template({ id })` → `{ id, label, description, instructions }`.
  Unknown id → `bad_request`. The agent reads `instructions` and applies
  them when generating HTML.
- `template?: string` added to `primer_create_document` and
  `primer_add_version` input schemas; forwarded through `client.ts` as a
  `template` form field on the multipart upload.

### 3. API + schema — `apps/api`

- **Schema**: nullable `template text` column on `versions` (stores the id
  string only). Drizzle migration `0007_*`, committed, mirrored into
  `primer_test`.
- **Upload** (`/api/upload`) and **add-version**
  (`/api/documents/:id/versions`): read the `template` form field; if
  present and not a valid id → `400 bad_request`; persist on the version.
- **DTOs**: `template: DocumentTemplate | null` added to `VersionSummary`
  (doc detail) and `VersionSummaryDTO` (versions list — this is the shape
  the web viewer uses to pick the badge). Resolved at read time via
  `resolveDocumentTemplate`, so label/color edits propagate to old rows.

### 4. Web badge — `apps/web`

- New `components/TemplateBadge.tsx`: a small chip — color swatch + label,
  tinted with the template color, `title` tooltip, non-interactive.
- `routes/document.tsx`: render `<TemplateBadge>` in the header next to the
  `VersionSelector` when `currentVersion?.template` is set. Badge follows the
  viewed version.

### 5. Skill workflow — `plugins/primer/skills/primer`

- `SKILL.md` create/iterate steps: when the user asks for a template (or to
  see options), call `primer_list_templates`, then `primer_get_template`,
  apply the instructions when (re)generating HTML, and pass `template` to
  create/add_version. Record `template` in `.primer/document.json`.
- `reference.md`: document the two new tools, the `template` arg, the
  `.primer/document.json` `template` field, and validation behavior.

## Non-goals

- The manual web upload form (`routes/upload.tsx`) does **not** offer
  template selection — there is no agent there to apply the skill. It still
  renders the badge if a version carries one.
- No server-side CSS injection.
- No template detail/info page (badge is non-clickable).

## Testing

- **shared registry** (exercised via the MCP package's vitest, since
  `@primer/shared` has no test runner of its own and adding one would touch
  the lockfile): catalog shape, `getTemplate`, `isValidTemplateId`,
  `resolveDocumentTemplate` (valid id, null, unknown id).
- **MCP** (`tools.test.ts`, `client.test.ts`): `primer_list_templates`
  shape, `primer_get_template` valid + unknown-id error, `template`
  forwarded as a form field by create/add_version.
- **API** (`upload.test.ts`, `versions.test.ts`): persist template on a
  version, invalid id → 400, DTO includes resolved template, untemplated
  version → `template: null`. (Requires the Postgres test harness.)
- **web** (`TemplateBadge` test): renders label when template present.

## Deployment note

The badge only appears on prod once the API + web are deployed to Railway
*and* the bumped MCP is published and pulled by the plugin. The paperclip
styling itself renders today (it is just artifact HTML); this feature adds
the recorded tag + badge.
