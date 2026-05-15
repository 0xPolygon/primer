import type { MsgOpenExternal } from '@primer/shared';

export function isSafeExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

export function handleOpenExternal(msg: MsgOpenExternal): void {
  if (!isSafeExternalUrl(msg.url)) {
    // eslint-disable-next-line no-console
    console.warn('[primer] rejected open_external', msg.url);
    return;
  }
  window.open(msg.url, '_blank', 'noopener,noreferrer');
}
