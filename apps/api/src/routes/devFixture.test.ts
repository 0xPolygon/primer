import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { ARTIFACT_CSP } from './versionContent.ts';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'primer-devfixture-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('GET /dev/fixtures/anchoring.html', () => {
  it('serves the fixture with the locked artifact CSP when NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV;
    const app = createApp({ storage: new FilesystemStorage(root) });
    const res = await app.request('/dev/fixtures/anchoring.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');

    const body = await res.text();
    expect(body).toContain('Primer anchoring fixture');
    expect(body).toContain('<script src="/companion/v1.js"');
  });

  it('is NOT registered when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const app = createApp({ storage: new FilesystemStorage(root) });
    const res = await app.request('/dev/fixtures/anchoring.html');
    expect(res.status).toBe(404);
  });
});
