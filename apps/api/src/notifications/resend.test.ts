import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResendNotifier } from './resend.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { NotifyCommentArgs } from './notifier.ts';
import { sql } from 'drizzle-orm';

const NOW = new Date('2026-05-20T12:00:00Z');

function args(over: Partial<NotifyCommentArgs> = {}): NotifyCommentArgs {
  return {
    doc: { id: 'doc-1', title: 'Test Doc' },
    version: { id: 'v-1', versionNumber: 3 },
    thread: { id: 'thread-abc' },
    comment: { id: 'c-1', body: 'hello @Alice', createdAt: NOW },
    mentionedUserIds: ['mock-user-2'],
    participantUserIds: [],
    actorUserId: 'mock-user-1',
    ...over,
  };
}

describe('ResendNotifier.notifyComment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Alice Tester' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
      ])
      .onConflictDoUpdate({
        target: users.id,
        set: { email: sql`excluded.email`, displayName: sql`excluded.display_name` },
      });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'resend-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Restore mock-user-1 to its canonical seed values so subsequent test files
    // that rely on the original email/displayName are not affected.
    await db
      .insert(users)
      .values([{ id: 'mock-user-1', email: 'mock@polygon.technology', displayName: 'Mock User' }])
      .onConflictDoUpdate({
        target: users.id,
        set: { email: sql`excluded.email`, displayName: sql`excluded.display_name` },
      });
  });

  it('POSTs to api.resend.com with bearer auth and the expected body', async () => {
    const n = new ResendNotifier({
      apiKey: 'sk-test',
      fromAddress: 'primer@sequence-demos.xyz',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyComment(args());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe('primer@sequence-demos.xyz');
    expect(body.to).toBe('two@p.t');
    expect(body.subject).toBe("User One commented on 'Test Doc'");
    expect(body.html).toContain('https://primer.example/d/doc-1/v/3#thread-thread-abc');
    expect(body.text).toContain('https://primer.example/d/doc-1/v/3#thread-thread-abc');
  });

  it('renders mention-only signal copy', async () => {
    const n = new ResendNotifier({
      apiKey: 'k',
      fromAddress: 'p@s.x',
      appBaseUrl: 'https://p.x',
    });
    await n.notifyComment(args({ mentionedUserIds: ['mock-user-2'], participantUserIds: [] }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('mentioned you in a comment');
    expect(body.text).not.toContain('replied to a thread');
  });

  it('renders reply-only signal copy', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({ mentionedUserIds: [], participantUserIds: ['mock-user-2'] }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("replied to a thread you're in");
    expect(body.text).not.toContain('mentioned you');
  });

  it('renders combined signal copy', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({ mentionedUserIds: ['mock-user-2'], participantUserIds: ['mock-user-2'] }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("mentioned you and replied to a thread you're in");
  });

  it('sends one email per unique recipient (union, dedup)', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({
      mentionedUserIds: ['mock-user-2', 'mock-user-3'],
      participantUserIds: ['mock-user-2'],          // user-2 in both → still one email
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const toValues = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).to);
    expect(toValues.sort()).toEqual(['three@p.t', 'two@p.t']);
  });

  it('excludes the actor even if accidentally in either list', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({
      mentionedUserIds: ['mock-user-1', 'mock-user-2'],   // actor accidentally included
      participantUserIds: ['mock-user-1'],
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.to).toBe('two@p.t');
  });

  it('does not throw when Resend returns 5xx; logs and continues to the next recipient', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok' }), { status: 200 }));
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await expect(
      n.notifyComment(args({ mentionedUserIds: ['mock-user-2', 'mock-user-3'] })),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('truncates doc title in subject at 50 chars', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    const longTitle = 'A'.repeat(80);
    await n.notifyComment(args({ doc: { id: 'd', title: longTitle } }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.subject.length).toBeLessThanOrEqual('User One commented on '.length + 50 + 3);
    expect(body.subject).toContain('…');
  });
});
