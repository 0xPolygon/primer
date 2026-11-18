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

export interface DeferredCopyAdapter {
  /** Writes text that isn't ready yet. Must be called synchronously inside
   *  the user's click so the browser ties the write to that gesture. Absent
   *  where ClipboardItem isn't supported. */
  writeDeferred?: (text: Promise<string>) => Promise<void>;
  copyNow: (text: string) => Promise<CopyResult>;
}

function defaultWriteDeferred(): DeferredCopyAdapter['writeDeferred'] {
  if (
    typeof navigator === 'undefined' ||
    typeof ClipboardItem === 'undefined' ||
    !navigator.clipboard?.write
  ) {
    return undefined;
  }
  return (text) =>
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })),
      }),
    ]);
}

/** Copy text that is still being fetched or built when the user clicks.
 *  Safari only allows clipboard writes inside the click's activation and
 *  Chrome only while the page is focused, so a plain copy after an `await`
 *  fails in one or the other. Handing the browser a pending ClipboardItem
 *  during the click works in both; where that's unsupported or refused,
 *  fall back to copying once the text resolves. Rejects if `text` does. */
export async function copyDeferredText(
  text: Promise<string>,
  adapter: DeferredCopyAdapter = {
    writeDeferred: defaultWriteDeferred(),
    copyNow: (t) => copyText(t),
  },
): Promise<CopyResult> {
  if (adapter.writeDeferred) {
    try {
      await adapter.writeDeferred(text);
      return 'api';
    } catch {
      // Fall through: rethrows below if the text itself failed.
    }
  }
  return adapter.copyNow(await text);
}
