import { describe, it, expect } from 'vitest';
import { transformHtml } from './htmlPipeline.ts';

describe('transformHtml', () => {
  it('returns serialized HTML with dangerous content stripped and companion script injected', () => {
    const input =
      '<html><body><h1>Report</h1><iframe src="x"></iframe><script>alert(1)</script></body></html>';
    const out = transformHtml(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.html).toContain('<h1>Report</h1>');
    expect(out.html).not.toContain('<iframe');
    expect(out.html).not.toMatch(/<script>alert/);
    // Companion script is injected by inject.ts after sanitization.
    expect(out.html).toContain('<script src="/companion/v1.js"');
  });

  it('returns parse_failed when input is not parseable as HTML', () => {
    const out = transformHtml('');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('parse_failed');
  });
});
