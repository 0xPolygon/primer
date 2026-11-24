import type { AuthUser } from '../app.ts';
import { fenceUntrusted } from '../lib/untrusted.ts';
import type { ToolHandler, ToolName, ToolResult } from './tools.ts';

/**
 * Untrusted-content fencing at the MCP tool-result boundary. Everything on
 * /mcp reaches an agent's context, whoever holds the credential (an OAuth
 * agent, or a person's token an agent was handed), so every handler runs
 * with `viaMcp` set (fencing for the records, widgets, digests, decisions and
 * tasks the domain code already fences) and the text the tools return raw is
 * fenced here: document bodies and comment text. Fencing reduces accidental
 * instruction following; it is not an authorization control.
 */

const fence = (s: unknown): unknown => (typeof s === 'string' ? fenceUntrusted(s, 'content') : s);

/** Block props that are the editor's own enums, not people's words. */
const STRUCTURAL_PROPS = new Set(['textColor', 'backgroundColor', 'textAlignment']);

/** BlockNote inline content with every text run fenced; node types, styles
 *  and the rest of the shape stay, so clients still parse it. */
function fenceInline(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fenceInline);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, k === 'text' && typeof x === 'string' ? fence(x) : k === 'content' ? fenceInline(x) : x]),
    );
  }
  return v;
}

type Obj = Record<string, unknown>;

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
        j.content = fenceInline(j.content);
        if (j.props && typeof j.props === 'object') {
          j.props = Object.fromEntries(
            Object.entries(j.props as Obj).map(([k, x]) => [k, STRUCTURAL_PROPS.has(k) ? x : fence(x)]),
          );
        }
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
  if (!fencer || result.isError) return result;
  return {
    ...result,
    content: result.content.map((part) => {
      const out = JSON.parse(part.text) as Obj;
      fencer(out);
      return { ...part, text: JSON.stringify(out) };
    }),
  };
}

/** `handler` for tool `name`, run as an MCP caller with its result fenced. */
export function fencedHandler(name: ToolName, handler: ToolHandler): ToolHandler {
  return async (args, user, scopes) => {
    const caller: AuthUser = { ...user, viaMcp: true };
    return fenceResult(name, await handler(args, caller, scopes));
  };
}
