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
