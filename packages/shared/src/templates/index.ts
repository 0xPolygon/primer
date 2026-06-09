/**
 * Document template registry.
 *
 * A "template" is a named, vendored Agent Skill. When the agent creates or
 * revises a Primer document it can apply a template's instructions to generate
 * styled HTML, then publish with the template id recorded on the version.
 *
 * This module is the single source of truth shared by:
 *   - the MCP server (`primer_list_templates` / `primer_get_template`, and
 *     validating the `template` field it forwards), and
 *   - the API (validating the `template` form field on upload, and resolving a
 *     stored id back to a display DTO at read time).
 *
 * The server never applies a template — it only records the id and shows a
 * badge. Styling lives entirely in the skill instructions, which the agent runs.
 */
import { PAPERCLIP_PUNKIFY_INSTRUCTIONS } from './paperclip-punkify/instructions.ts';

/** Full template record, including the heavy instructions blob. */
export interface Template {
  /** Stable id stored on the version row and passed over the wire. */
  id: string;
  /** Human-facing name shown on the badge, e.g. "Paperclip Punk". */
  label: string;
  /** One-line summary for discovery (`primer_list_templates`). */
  description: string;
  /** Accent color (hex) used to tint the badge. */
  color: string;
  /** Upstream Agent Skill name this template vendors, for provenance. */
  skillName: string;
  /** Verbatim skill instructions the agent applies when generating HTML. */
  instructions: string;
}

/** Lightweight catalog entry — no instructions, cheap to list. */
export interface TemplateSummary {
  id: string;
  label: string;
  description: string;
}

/** Display shape returned in API DTOs and rendered as the web badge. */
export interface DocumentTemplate {
  id: string;
  label: string;
  color: string;
}

/**
 * The catalog. Keyed by id. Add a new template by dropping a folder under
 * `templates/` with an `instructions.ts` and registering it here.
 */
export const TEMPLATES: Record<string, Template> = {
  'paperclip-punkify': {
    id: 'paperclip-punkify',
    label: 'Paperclip Punk',
    description:
      'Retro editorial-technical manual: off-white paper, Polygon-violet blueprint diagrams, pixel labels, dense serif text.',
    color: '#670DE5',
    skillName: 'polygon-paperclip-punkify',
    instructions: PAPERCLIP_PUNKIFY_INSTRUCTIONS,
  },
};

/** All templates as lightweight summaries, for discovery. */
export function listTemplates(): TemplateSummary[] {
  return Object.values(TEMPLATES).map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

/** Look up a full template (with instructions) by id. */
export function getTemplate(id: string): Template | undefined {
  return TEMPLATES[id];
}

/** True if `id` names a known template. */
export function isValidTemplateId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id);
}

/**
 * Resolve a stored template id to its current display DTO. Returns null for
 * `null` (untemplated version) or an unknown id (template was removed from the
 * registry after a version recorded it — degrade gracefully to no badge).
 */
export function resolveDocumentTemplate(id: string | null): DocumentTemplate | null {
  if (id === null) return null;
  const t = TEMPLATES[id];
  if (!t) return null;
  return { id: t.id, label: t.label, color: t.color };
}
