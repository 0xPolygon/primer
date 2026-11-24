import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../app.ts';

/** Whether what this caller reads reaches an agent's context: an agent
 *  identity, or anyone on the MCP surface (a person's token an agent holds).
 *  Fencing only; permissions still follow `actor.kind`. */
export function readsUntrusted(actor: AuthUser): boolean {
  return actor.kind === 'agent' || actor.viaMcp === true;
}

/**
 * Text written by people, fenced for an agent's context: data, never
 * instructions. The tag carries a random nonce per call, so the text can't
 * name its closing tag. The text inside is exact, never escaped, so an agent
 * that reads, edits and writes it back round-trips it (writes refuse fence
 * markup, see `hasFenceMarkup`). `label` names what the text
 * is, e.g. `request` gives `<untrusted-request-1f9c…>…</untrusted-request-1f9c…>`.
 */
export function fenceUntrusted(text: string, label?: string): string {
  if (label !== undefined && !/^[a-z]+$/.test(label)) throw new Error(`fence label must be lowercase letters: ${label}`);
  const tag = `untrusted-${label ? `${label}-` : ''}${randomBytes(8).toString('hex')}`;
  return `<${tag}>\n${text}\n</${tag}>`;
}

/** Whether `text` holds a complete fence tag (`<untrusted-…-nonce>` or its closing tag): text
 *  read back from a fence must be unwrapped before it is written. */
export function hasFenceMarkup(text: string): boolean {
  return /<\/?untrusted-(?:[a-z]+-)?[0-9a-f]{16}>/i.test(text);
}

/** Which names of a DTO are Primer's own: `keys` are its field names (any
 *  other key is data and gets fenced), `plain` the fields whose string value
 *  Primer built or validated itself (ids, timestamps, enums). Literal sets
 *  written beside the DTO, never derived from what a name looks like. */
export type FenceAllow = { keys?: ReadonlySet<string>; plain?: ReadonlySet<string> };

/**
 * `value` with every string in it fenced, keys included: JSON that people
 * wrote, for an agent. Numbers, booleans and the shape stay. Fenced by
 * default: only the names in `allow` are left alone, so a field nobody
 * listed can't carry text through bare. An element of an array takes the
 * plainness of the array's key.
 */
export function fenceStrings<T>(value: T, label: string, allow: FenceAllow = {}, plain = false): T {
  if (typeof value === 'string') return (plain ? value : fenceUntrusted(value, label)) as T;
  if (Array.isArray(value)) return value.map((v) => fenceStrings(v, label, allow, plain)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        allow.keys?.has(k) ? k : fenceUntrusted(k, label),
        fenceStrings(v, label, allow, allow.plain?.has(k) ?? false),
      ]),
    ) as T;
  }
  return value;
}
