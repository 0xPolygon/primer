import type { createApp } from '../app.ts';
import { CSRF_HEADERS } from '../test/harness.ts';

const TINY_HTML = '<html><body><h1>fixture</h1></body></html>';

export async function uploadFixture(app: ReturnType<typeof createApp>): Promise<{
  documentId: string;
  versionId: string;
  url: string;
}> {
  const fd = new FormData();
  fd.append('file', new Blob([TINY_HTML], { type: 'text/html' }), 'fixture.html');
  fd.append('title', 'Fixture doc');
  const res = await app.request('/api/upload', {
    method: 'POST',
    headers: CSRF_HEADERS,
    body: fd,
  });
  if (!res.ok) throw new Error(`uploadFixture failed: ${res.status}`);
  const body = (await res.json()) as { documentId: string; versionId: string; url: string };
  return body;
}
