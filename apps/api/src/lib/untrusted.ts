import { randomBytes } from 'node:crypto';

/**
 * Text written by people, fenced for an agent's context: data, never
 * instructions. The tag carries a random nonce per call, so the text can't
 * name its closing tag, and `&`, `<` and `>` inside are escaped, so no tag
 * survives in it at all (deleting matches instead is bypassable:
 * `<untr<untrusted>usted>` leaves a tag behind). `label` names what the text
 * is, e.g. `request` gives `<untrusted-request-1f9c…>…</untrusted-request-1f9c…>`.
 */
export function fenceUntrusted(text: string, label?: string): string {
  if (label !== undefined && !/^[a-z]+$/.test(label)) throw new Error(`fence label must be lowercase letters: ${label}`);
  const tag = `untrusted-${label ? `${label}-` : ''}${randomBytes(8).toString('hex')}`;
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<${tag}>\n${escaped}\n</${tag}>`;
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
