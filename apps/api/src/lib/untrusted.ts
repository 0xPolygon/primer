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

/** A plain data key (RECORD_KEY_RE's shape): passes unfenced. */
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * JSON data people wrote (record data, widget rows), for an agent: every
 * string value fenced with `fenceUntrusted`, and every key that isn't a plain
 * data key too, so the shape stays usable and no text in it reads as an
 * instruction. `keep` names top-level keys left as they are (identifiers
 * Primer validated, such as a row's record id). Fencing happens where an
 * agent reads, never in storage.
 */
export function fenceData<T>(value: T, label: string, keep: readonly string[] = []): T {
  const walk = (v: unknown, top: boolean): unknown => {
    if (typeof v === 'string') return fenceUntrusted(v, label);
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (typeof v !== 'object' || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (top && keep.includes(k)) out[k] = x;
      else out[PLAIN_KEY.test(k) ? k : fenceUntrusted(k, label)] = walk(x, false);
    }
    return out;
  };
  return walk(value, true) as T;
}
