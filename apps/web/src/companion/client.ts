import type { MsgOpenExternal } from './protocol.ts';

// Primer's own origin is refused: opened top-level, a Primer URL (an
// artifact's content route, say) is no longer inside the iframe sandbox.
export function isSafeExternalUrl(
  raw: string,
  ownOrigin: string | undefined = globalThis.location?.origin,
): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.origin !== ownOrigin;
}

export function handleOpenExternal(msg: MsgOpenExternal): void {
  if (!isSafeExternalUrl(msg.url)) {
    // eslint-disable-next-line no-console
    console.warn('[primer] rejected open_external', msg.url);
    return;
  }
  window.open(msg.url, '_blank', 'noopener,noreferrer');
}
