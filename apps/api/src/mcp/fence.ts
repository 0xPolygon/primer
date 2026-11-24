import type { AuthUser } from '../app.ts';
import { fenceUntrusted, hasFenceMarkup } from '../lib/untrusted.ts';
import type { ToolHandler, ToolName, ToolResult } from './tools.ts';

/**
 * Untrusted-content fencing at the MCP tool-result boundary. Everything on
 * /mcp reaches an agent's context, whoever holds the credential (an OAuth
 * agent, or a person's token an agent was handed), so every handler runs
 * with `viaMcp` set (fencing for the records, widgets, digests, decisions and
 * tasks the domain code already fences) and the text the tools return raw is
 * fenced here: document bodies, comment text, and the short metadata (titles,
 * descriptions, version notes). Fencing reduces accidental instruction
 * following; it is not an authorization control.
 *
 * The text inside a fence is the exact original (nothing escaped), and
 * document writes (create, add version, apply ops) refuse fence markup, so a
 * read, edit, write round trip can't persist a fence.
 *
 * Left raw on purpose (decided 2026-11-24):
 *  - live-page `source`: round-tripped as code (republished with its pids);
 *  - event payloads (primer_get_events, primer_send_events): structured JSON
 *    the caller wrote;
 *  - the stdio plugin (apps/mcp): a person's own local tool on the person's
 *    token, the same trust as their browser; only /mcp fences.
 */

const fence = (s: unknown): unknown => (typeof s === 'string' ? fenceUntrusted(s, 'content') : s);

/** Keys whose values are the editor's own structure (node types, ids, styling),
 *  not people's words; every other string in block JSON is fenced. */
const STRUCTURAL_KEYS = new Set(['type', 'id', 'styles', 'textColor', 'backgroundColor', 'textAlignment']);

/** Block JSON (inline content, table rows and cells, chip and block props)
 *  with every string of people's words fenced; the shape, numbers and the
 *  structural keys stay, so clients still parse it. */
function fenceBlockJson(v: unknown): unknown {
  if (typeof v === 'string') return fence(v);
  if (Array.isArray(v)) return v.map(fenceBlockJson);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, STRUCTURAL_KEYS.has(k) ? x : fenceBlockJson(x)]));
  }
  return v;
}

type Obj = Record<string, unknown>;

/** The short metadata a document carries, at any depth of a tool result. */
const META_KEYS = new Set(['title', 'description', 'versionNote', 'documentTitle']);
const META_TOOLS = new Set<ToolName>([
  'primer_get_document',
  'primer_list_versions',
  'primer_list_documents',
  'primer_find_document',
  'primer_get_document_comments',
  'primer_get_all_comments',
]);

function fenceMeta(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(fenceMeta);
  if (v === null || typeof v !== 'object') return;
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (META_KEYS.has(k) && typeof o[k] === 'string') o[k] = fence(o[k]);
    else fenceMeta(o[k]);
  }
}

/** The tools that write document content: their arguments never carry fence markup. */
const DOC_WRITES = new Set<ToolName>(['primer_create_document', 'primer_add_version', 'primer_apply_ops']);
const FENCE_WRITE_REFUSAL =
  'The content holds <untrusted-…> fence markup. Reads wrap text in an untrusted-content fence: strip the fence tags before writing text back, and write only the text itself.';

/** A comment list: `body`, the quoted anchor text and rendered Markdown. */
function comments(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const c of list as Obj[]) {
    if ('body' in c) c.body = fence(c.body);
    if ('anchor_text' in c) c.anchor_text = fence(c.anchor_text);
  }
}

/** Per tool: the fields of its result that hold people's text. */
const FENCERS: Partial<Record<ToolName, (out: Obj) => void>> = {
  primer_get_version_content: (out) => {
    out.content = fence(out.content);
  },
  primer_get_doc: (out) => {
    for (const b of (out.blocks as Obj[] | undefined) ?? []) {
      if ('markdown' in b) b.markdown = fence(b.markdown);
      if ('html' in b) b.html = fence(b.html);
      if (b.json && typeof b.json === 'object') {
        const j = b.json as Obj;
        j.content = fenceBlockJson(j.content);
        j.props = fenceBlockJson(j.props);
      }
    }
  },
  primer_get_comments: (out) => {
    out.markdown = fence(out.markdown);
    comments(out.comments);
    comments((out.live as Obj | undefined)?.comments);
  },
  primer_get_document_comments: (out) => {
    for (const v of (out.versions as Obj[] | undefined) ?? []) v.markdown = fence(v.markdown);
    comments((out.live as Obj | undefined)?.comments);
  },
  primer_get_all_comments: (out) => comments(out.comments),
};

function fenceResult(name: ToolName, result: ToolResult): ToolResult {
  const fencer = FENCERS[name];
  const meta = META_TOOLS.has(name);
  if ((!fencer && !meta) || result.isError) return result;
  return {
    ...result,
    content: result.content.map((part) => {
      const out = JSON.parse(part.text) as Obj;
      fencer?.(out);
      if (meta) fenceMeta(out);
      return { ...part, text: JSON.stringify(out) };
    }),
  };
}

/** `handler` for tool `name`, run as an MCP caller with its result fenced. */
export function fencedHandler(name: ToolName, handler: ToolHandler): ToolHandler {
  return async (args, user, scopes) => {
    if (DOC_WRITES.has(name) && hasFenceMarkup(JSON.stringify(args))) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'bad_request', message: FENCE_WRITE_REFUSAL }) }] };
    }
    const caller: AuthUser = { ...user, viaMcp: true };
    return fenceResult(name, await handler(args, caller, scopes));
  };
}
