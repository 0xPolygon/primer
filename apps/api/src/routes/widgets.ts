import type { Context, Hono } from 'hono';
import type { WidgetDraftRequest } from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';
import { checkRateLimit } from '../lib/rateLimiter.ts';
import { draftWidget, getWidget, publishWidget, widgetImage, type WidgetResult } from '../widgets/store.ts';

type Ctx = Context<{ Variables: AppVariables }>;

function refused(c: Ctx, result: Extract<WidgetResult<unknown>, { ok: false }>) {
  const { refusal } = result;
  return c.json({ error: refusal.code, message: refusal.message, refusal }, result.status);
}

async function body<T>(c: Ctx): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** Agent-drawn widgets: draft (with PNG previews), publish exactly the
 *  preview, read, and the live image people see. */
export function registerWidgetRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.post('/api/documents/:docId/widgets/draft', async (c) => {
    const req = await body<WidgetDraftRequest>(c);
    if (!req) return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    // Every draft renders two PNGs on the server's worker pool.
    if (!checkRateLimit(`widget-draft:${c.get('user').id}`, 30)) return c.json({ error: 'rate_limited' }, 429);
    const result = await draftWidget(c.get('user'), c.req.param('docId'), req);
    return result.ok ? c.json(result.value) : refused(c, result);
  });

  app.post('/api/widgets/:widgetId/publish', async (c) => {
    const req = await body<{ previewHash?: unknown }>(c);
    if (typeof req?.previewHash !== 'string') {
      return c.json({ error: 'invalid_body', message: 'previewHash (from the draft) is required' }, 400);
    }
    const result = await publishWidget(c.get('user'), c.req.param('widgetId'), req.previewHash);
    return result.ok ? c.json(result.value) : refused(c, result);
  });

  app.get('/api/widgets/:widgetId', async (c) => {
    const result = await getWidget(c.get('user'), c.req.param('widgetId'));
    return result.ok ? c.json(result.value) : refused(c, result);
  });

  app.get('/api/widgets/:widgetId/image', async (c) => {
    const theme = c.req.query('theme') === 'dark' ? 'dark' : 'light';
    const format = c.req.query('format') === 'png' ? 'png' : 'svg';
    if (format === 'png' && !checkRateLimit(`widget-png:${c.get('user').id}`, 120)) return c.json({ error: 'rate_limited' }, 429);
    const result = await widgetImage(c.get('user'), c.req.param('widgetId'), theme, format);
    if (!result.ok) return refused(c, result);
    c.header('Cache-Control', 'private, no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    if ('png' in result.value) {
      c.header('Content-Type', 'image/png');
      return c.body(new Uint8Array(result.value.png));
    }
    // Allowlisted markup only (widgets/serialize.ts); opened directly, it runs nothing.
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    c.header('Content-Security-Policy', "default-src 'none'");
    return c.body(result.value.svg);
  });
}
