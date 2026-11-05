import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MailgunNotifier } from './mailgun.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { NotifyCommentArgs, NotifyCollaboratorAddedArgs } from './notifier.ts';
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
    uploaderUserId: null,
    actorUserId: 'mock-user-1',
    ...over,
  };
}

function parseForm(body: string) {
  const p = new URLSearchParams(body);
  return {
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    subject: p.get('subject') ?? '',
    text: p.get('text') ?? '',
    html: p.get('html') ?? '',
  };
}

describe('MailgunNotifier.notifyComment', () => {
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
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'mg-id', message: 'Queued. Thank you.' }), { status: 200 }),
    );
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

  it('POSTs to api.mailgun.net with Basic auth and a form-encoded body', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyComment(args());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailgun.net/v3/dashboard.polygon.technology/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    const expectedAuth = `Basic ${Buffer.from('api:sk-test').toString('base64')}`;
    expect(headers.Authorization).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = parseForm(init.body as string);
    expect(body.from).toBe('primer@dashboard.polygon.technology');
    expect(body.to).toBe('two@p.t');
    expect(body.subject).toBe("User One commented on 'Test Doc'");
    expect(body.html).toContain('https://primer.example/d/doc-1/v/3#thread-thread-abc');
    expect(body.text).toContain('https://primer.example/d/doc-1/v/3#thread-thread-abc');
  });

  it('honors apiBaseUrl override and url-encodes the domain segment', async () => {
    const n = new MailgunNotifier({
      apiKey: 'k',
      domain: 'mg.dashboard.polygon.technology',
      fromAddress: 'p@d.x',
      appBaseUrl: 'https://p.x',
      apiBaseUrl: 'https://api.eu.mailgun.net/',
    });
    await n.notifyComment(args());
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.dashboard.polygon.technology/messages');
  });

  it('renders mention-only signal copy', async () => {
    const n = new MailgunNotifier({
      apiKey: 'k',
      domain: 'd.x',
      fromAddress: 'p@d.x',
      appBaseUrl: 'https://p.x',
    });
    await n.notifyComment(args({ mentionedUserIds: ['mock-user-2'], participantUserIds: [] }));
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toContain('mentioned you in a comment');
    expect(body.text).not.toContain('replied to a thread');
  });

  it('renders reply-only signal copy', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({ mentionedUserIds: [], participantUserIds: ['mock-user-2'] }));
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toContain("replied to a thread you're in");
    expect(body.text).not.toContain('mentioned you');
  });

  it('renders combined signal copy', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({ mentionedUserIds: ['mock-user-2'], participantUserIds: ['mock-user-2'] }));
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toContain("mentioned you and replied to a thread you're in");
  });

  it('sends one email per unique recipient (union, dedup)', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: ['mock-user-2', 'mock-user-3'],
        participantUserIds: ['mock-user-2'], // user-2 in both → still one email
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const toValues = fetchMock.mock.calls.map(
      (c) => parseForm((c[1] as RequestInit).body as string).to,
    );
    expect(toValues.sort()).toEqual(['three@p.t', 'two@p.t']);
  });

  it('excludes the actor even if accidentally in either list', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: ['mock-user-1', 'mock-user-2'], // actor accidentally included
        participantUserIds: ['mock-user-1'],
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toBe('two@p.t');
  });

  it('does not throw when Mailgun returns 5xx; logs and continues to the next recipient', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok' }), { status: 200 }));
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await expect(
      n.notifyComment(args({ mentionedUserIds: ['mock-user-2', 'mock-user-3'] })),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('truncates doc title in subject at 50 chars', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    const longTitle = 'A'.repeat(80);
    await n.notifyComment(args({ doc: { id: 'd', title: longTitle } }));
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject.length).toBeLessThanOrEqual('User One commented on '.length + 50 + 3);
    expect(body.subject).toContain('…');
  });

  it('emails the uploader even when they are not @-mentioned or a participant', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: [],
        participantUserIds: [],
        uploaderUserId: 'mock-user-2',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toBe('two@p.t');
  });

  it('dedups the uploader against mentions and participants (one email)', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: ['mock-user-2'],
        participantUserIds: ['mock-user-2'],
        uploaderUserId: 'mock-user-2',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toBe('two@p.t');
  });

  it('does not email the uploader when they are the actor (self-skip)', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: [],
        participantUserIds: [],
        uploaderUserId: 'mock-user-1',   // same as default actorUserId
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders uploader-only lead copy (no mention, no participation)', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: [],
        participantUserIds: [],
        uploaderUserId: 'mock-user-2',
      }),
    );
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toContain('commented on a document you uploaded');
    expect(body.text).not.toContain("replied to a thread you're in");
    expect(body.text).not.toContain('mentioned you');
  });

  it('renders uploader+mention combined lead copy', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(
      args({
        mentionedUserIds: ['mock-user-2'],
        participantUserIds: [],
        uploaderUserId: 'mock-user-2',
      }),
    );
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text).toContain('mentioned you in a comment on a document you uploaded');
  });

  it('renders the updated footer copy in both text and HTML', async () => {
    const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args());
    const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const expected = 'You received this because you were mentioned, are a participant in this thread, or uploaded this document.';
    expect(body.text).toContain(expected);
    expect(body.html).toContain(expected);
  });
});

function collabArgs(over: Partial<NotifyCollaboratorAddedArgs> = {}): NotifyCollaboratorAddedArgs {
  return {
    docId: 'doc-1',
    docTitle: 'Test Doc',
    addedUserId: 'mock-user-2',
    addedByUserId: 'mock-user-1',
    role: 'editor',
    ...over,
  };
}

describe('MailgunNotifier.notifyCollaboratorAdded', () => {
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
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'mg-id', message: 'Queued. Thank you.' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db
      .insert(users)
      .values([{ id: 'mock-user-1', email: 'mock@polygon.technology', displayName: 'Mock User' }])
      .onConflictDoUpdate({
        target: users.id,
        set: { email: sql`excluded.email`, displayName: sql`excluded.display_name` },
      });
  });

  it('POSTs a single email to the added user with subject and body', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailgun.net/v3/dashboard.polygon.technology/messages');
    const form = parseForm(String(init.body));
    expect(form.to).toBe('two@p.t');
    expect(form.subject).toBe(`You were added to 'Test Doc' on Primer`);
    expect(form.text).toContain('User One added you as an editor');
    expect(form.text).toContain('https://primer.example/d/doc-1');
    expect(form.html).toContain('User One');
    expect(form.html).toContain('added you as an <strong>editor</strong>');
    expect(form.html).toContain('href="https://primer.example/d/doc-1"');
  });

  it('renders commenter role text', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ role: 'commenter' }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = parseForm(String(init.body));
    expect(form.text).toContain('User One added you as a commenter');
    expect(form.html).toContain('added you as a <strong>commenter</strong>');
  });

  it('renders responder role text', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ role: 'responder' }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = parseForm(String(init.body));
    expect(form.text).toContain('added you as a responder');
    expect(form.html).toContain('added you as a <strong>responder</strong>');
  });

  it('suppresses self-add (no HTTP request)', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ addedUserId: 'mock-user-1' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips send if added user has no email row (logs and returns)', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ addedUserId: 'unknown-user-xyz' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const cfg = {
  apiKey: 'k', domain: 'mg.example.com',
  fromAddress: 'primer@mg.example.com', appBaseUrl: 'https://primer.example.com',
};

describe('MailgunNotifier external emails', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emailEnabled is true', () => {
    expect(new MailgunNotifier(cfg).emailEnabled).toBe(true);
  });

  it('notifyExternalOtp sends the code in the body, not the subject, with no links', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await new MailgunNotifier(cfg).notifyExternalOtp({ toEmail: 'client@example.com', code: '123456' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.get('to')).toBe('client@example.com');
    expect(body.get('subject')).not.toContain('123456');
    expect(body.get('text')).toContain('123456');
    expect(body.get('text')).not.toContain('http');   // no clickable auth links
    expect(body.get('html')).not.toContain('http');   // no clickable auth links in HTML either
    expect(body.get('text')).not.toContain('Deck');   // never the doc title pre-verification
  });

  it('notifyExternalFirstView emails the sharer with viewer email and doc link', async () => {
    await db.insert(users).values({
      id: 'sharer-1', email: 'sharer@polygon.technology', displayName: 'Sharer',
    }).onConflictDoNothing();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await new MailgunNotifier(cfg).notifyExternalFirstView({
      sharerUserId: 'sharer-1', viewerEmail: 'client@example.com',
      docId: '0198c5a0-0000-7000-8000-000000000000', docTitle: 'Q3 Deck',
    });
    const body = new URLSearchParams(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.get('to')).toBe('sharer@polygon.technology');
    expect(body.get('subject')).toContain('client@example.com');
    expect(body.get('text')).toContain('/d/0198c5a0-0000-7000-8000-000000000000');
  });
});
