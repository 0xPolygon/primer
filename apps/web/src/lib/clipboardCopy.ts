export type CopyResult = 'api' | 'fallback' | 'failed';

export interface CopyAdapter {
  writeWithApi: (text: string) => Promise<void>;
  writeWithFallback: (text: string) => boolean;
}

/** DOM-based fallback for browsers/contexts where navigator.clipboard is
 *  unavailable (insecure context, very old browsers). Hidden textarea +
 *  document.execCommand('copy'). */
function defaultFallback(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function defaultApi(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.reject(new Error('clipboard API unavailable'));
  }
  return navigator.clipboard.writeText(text);
}

const DEFAULT_ADAPTER: CopyAdapter = {
  writeWithApi: defaultApi,
  writeWithFallback: defaultFallback,
};

export async function copyText(
  text: string,
  adapter: CopyAdapter = DEFAULT_ADAPTER,
): Promise<CopyResult> {
  try {
    await adapter.writeWithApi(text);
    return 'api';
  } catch {
    return adapter.writeWithFallback(text) ? 'fallback' : 'failed';
  }
}
