import { describe, it, expect } from 'vitest';

// Runs only in container mode (see vitest.config.ts): every request goes over
// HTTP to a booted image, so nothing here may import the app.
const baseUrl = process.env.TEST_BASE_URL;
if (!baseUrl) {
  throw new Error('TEST_BASE_URL must be set: this suite only runs against a booted container');
}

// Never follow redirects, so a case can't silently pass by landing on another page.
const get = (path: string): Promise<Response> => fetch(new URL(path, baseUrl), { redirect: 'manual' });

describe('container smoke', () => {
  it('serves liveness at /api/health', async () => {
    const res = await get('/api/health');
    expect(res.status).equal(200);
    expect(await res.json()).property('ok', true);
  });

  it('serves the SPA at the public share path', async () => {
    const res = await get('/share/smoke-probe');
    expect(res.status).equal(200);
    expect(res.headers.get('content-type')).include('text/html');
    expect(await res.text()).include('id="root"');
  });

  it('serves the built JS bundle referenced by the SPA', async () => {
    const html = await (await get('/share/smoke-probe')).text();
    const match = /src="(\/assets\/[^"]+\.js)"/.exec(html);
    expect(match).not.equal(null);
    const src = match?.[1];
    if (!src) throw new Error('no /assets/*.js script tag in index.html');
    const res = await get(src);
    expect(res.status).equal(200);
    expect(res.headers.get('content-type')).match(/javascript/);
  });

  it('serves the companion script', async () => {
    const res = await get('/companion/v1.js');
    expect(res.status).equal(200);
  });

  it('rejects unauthenticated /api/me with 401', async () => {
    const res = await get('/api/me');
    expect(res.status).equal(401);
  });

  // The auth middleware answers 401 for unauthenticated /auth/* before any
  // route runs, so this proves that branch of the gate, not whether mock-auth
  // routes are registered; NODE_ENV=production baked into the image is what
  // keeps those out.
  it('rejects unauthenticated /auth/* with 401', async () => {
    const res = await get('/auth/mock');
    expect(res.status).equal(401);
  });

  it('redirects unauthenticated page requests to the login flow', async () => {
    const res = await get('/');
    expect(res.status).equal(302);
    expect(res.headers.get('location')).match(/^\/auth\/login/);
  });
});
