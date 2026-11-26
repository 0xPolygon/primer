import { describe, it, expect } from 'vitest';
import { artifactCsp, pageBridgeFeatures } from './pagePolicy.ts';

describe('page outbound policy', () => {
  it('standard policy is the pre-policy ARTIFACT_CSP plus the sandbox', () => {
    expect(artifactCsp('standard')).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline' blob: cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev; style-src 'self' 'unsafe-inline' blob: cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net fonts.googleapis.com; connect-src 'none'; img-src data: blob: 'self' https:; font-src 'self' blob: data: fonts.gstatic.com; form-action 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; sandbox allow-scripts allow-forms allow-modals allow-downloads",
    );
  });

  it('records policy allows no remote origin', () => {
    const csp = artifactCsp('records');
    expect(csp).toContain("connect-src 'none'");
    for (const directive of csp.split('; ').filter((d) => !d.startsWith('sandbox'))) {
      const sources = directive.split(' ').slice(1);
      for (const src of sources) {
        // Only keywords ('self', 'none', …) and local schemes: no http(s):,
        // no host names.
        expect(src === 'data:' || src === 'blob:' || /^'[a-z-]+'$/.test(src)).toBe(true);
      }
    }
  });

  it('both policies sandbox the document without same-origin or popups', () => {
    for (const policy of ['standard', 'records'] as const) {
      const csp = artifactCsp(policy);
      expect(csp).toContain('sandbox allow-scripts allow-forms allow-modals allow-downloads');
      expect(csp).not.toMatch(/allow-same-origin|allow-popups/);
    }
  });

  it('records policy disables open_external', () => {
    expect(pageBridgeFeatures('records')).toEqual({ openExternal: false, forwardNavigation: false });
    expect(pageBridgeFeatures('standard')).toEqual({ openExternal: true, forwardNavigation: true });
  });
});
