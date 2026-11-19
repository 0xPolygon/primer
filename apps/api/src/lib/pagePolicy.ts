// The Content-Security-Policy every served page (artifact) gets, by outbound
// policy. Pages run in a sandboxed iframe with an opaque origin (see
// apps/web ArtifactIframe), so the CSP is what limits where a page's content
// can send data.
//
// - `standard`: today's policy for every page. Remote scripts, styles and
//   fonts from a few CDNs and remote images are allowed so self-contained
//   dashboards work; `connect-src 'none'` and `form-action 'none'` block the
//   page from calling out.
// - `records`: for pages that read shared records (M9). Nothing remote at
//   all, so record data has no request to ride out on; the host also turns
//   off the bridge's outbound features for such pages (pageBridgeFeatures).

export type PagePolicy = 'standard' | 'records';

const STANDARD_CSP = [
  "default-src 'none'",
  // blob: required for self-bundled artifacts that decode JS/CSS/fonts from
  // an embedded base64 manifest into blob: URLs at runtime. Blob URLs are
  // origin-bound to the creator (the sandboxed opaque-origin iframe) so this
  // does not expand the exfil surface — connect-src 'none' still blocks all
  // outbound network from the artifact.
  // 'unsafe-inline' is required so uploaded artifacts can ship inline
  // <script> blocks and on* event handlers — that's the only way most
  // interactive dashboards work. The threat surface this opens is bounded
  // by ArtifactIframe's sandbox (opaque origin, no `allow-same-origin`) plus
  // `connect-src 'none'` and `form-action 'none'` below: inline JS runs,
  // but cannot reach Primer cookies/storage/parent DOM, cannot make network
  // requests, and cannot submit forms.
  "script-src 'self' 'unsafe-inline' blob: cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev",
  "style-src 'self' 'unsafe-inline' blob: cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net fonts.googleapis.com",
  "connect-src 'none'",
  "img-src data: blob: 'self' https:",
  "font-src 'self' blob: data: fonts.gstatic.com",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const RECORDS_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function artifactCsp(policy: PagePolicy): string {
  return policy === 'records' ? RECORDS_CSP : STANDARD_CSP;
}

/** What the host's bridge does for a page: open links outside Primer
 *  (`open_external`) and follow the page's anchor navigation. Both are off
 *  for record-reading pages, and the host ignores those messages from them. */
export interface PageBridgeFeatures {
  openExternal: boolean;
  forwardNavigation: boolean;
}

export function pageBridgeFeatures(policy: PagePolicy): PageBridgeFeatures {
  const outbound = policy === 'standard';
  return { openExternal: outbound, forwardNavigation: outbound };
}
