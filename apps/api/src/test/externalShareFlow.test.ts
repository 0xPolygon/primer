// apps/api/src/test/externalShareFlow.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier, type NotifyExternalOtpArgs, type NotifyExternalFirstViewArgs } from '../notifications/notifier.ts';
import { _resetRateLimiterForTests } from '../lib/rateLimiter.ts';
import { CSRF_HEADERS, asUserJson, asUser } from './harness.ts';

class CaptureNotifier extends NoopNotifier {
  override readonly emailEnabled = true;
  otps: NotifyExternalOtpArgs[] = [];
  firstViews: NotifyExternalFirstViewArgs[] = [];
  override async notifyExternalOtp(a: NotifyExternalOtpArgs): Promise<void> { this.otps.push(a); }
  override async notifyExternalFirstView(a: NotifyExternalFirstViewArgs): Promise<void> { this.firstViews.push(a); }
}

const JSON_HEADERS = { ...CSRF_HEADERS, 'content-type': 'application/json' };

describe('external sharing: full lifecycle over HTTP', () => {
  beforeEach(() => _resetRateLimiterForTests());

  it('create → recipient → publish → OTP → view → audit → revoke → dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-e2e-ext-'));
    const notifier = new CaptureNotifier();
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier });

      // Internal user uploads a doc.
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>Deal Deck</h1></body></html>'], { type: 'text/html' }), 'd.html');
      fd.append('title', 'Deal Deck');
      const up = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      const { documentId, versionId } = (await up.json()) as { documentId: string; versionId: string };

      // Create share, add recipient, publish — all through the admin API.
      const created = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const { share } = (await created.json()) as { share: { shareToken: string } };
      await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'client@example.com' }),
      });
      await app.request(`/api/documents/${documentId}/external-share/publish`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ versionId }),
      });

      // External client: request code → verify → view. No internal auth headers.
      await app.request(`/api/share/${share.shareToken}/request-code`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'client@example.com' }),
      });
      expect(notifier.otps.length).toBe(1);
      const verify = await app.request(`/api/share/${share.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'client@example.com', code: notifier.otps[0].code }),
      });
      expect(verify.status).toBe(200);
      const cookie = verify.headers.get('set-cookie')!.split(';')[0];

      const view = await app.request(`/api/share/${share.shareToken}/content`, { headers: { cookie } });
      expect(view.status).toBe(200);
      expect(await view.text()).toContain('<h1 data-pid="p1">Deal Deck</h1>');
      expect(notifier.firstViews.length).toBe(1);
      expect(notifier.firstViews[0].sharerUserId).toBe('mock-user-1');

      // Sharer sees the engagement in the admin payload.
      const adminView = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-1'),
      });
      const adminBody = (await adminView.json()) as {
        recipients: Array<{ viewCount: number; firstViewedAt: string | null }>;
      };
      expect(adminBody.recipients[0].viewCount).toBe(1);
      expect(adminBody.recipients[0].firstViewedAt).not.toBeNull();

      // Kill switch: revoke the whole share → the existing session is dead.
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'DELETE', headers: asUserJson('mock-user-1'),
      });
      const dead = await app.request(`/api/share/${share.shareToken}/content`, { headers: { cookie } });
      expect(dead.status).toBe(302);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
