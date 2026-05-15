import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type {
  DashboardResponse,
  DashboardDocumentSummary,
  DashboardActivityEntry,
} from '@primer/shared';
import { db } from '../db/client.ts';

interface MyDocRow {
  id: string;
  title: string;
  description: string | null;
  uploaderDisplayName: string;
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string | Date;
}

interface ActivityRow extends MyDocRow {
  signal: 'viewed' | 'commented';
  signalAt: string | Date;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseInt(String(v), 10);
}

export function registerDashboardRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/dashboard', async (c) => {
    const userId = c.get('user').id;

    // ── My documents ───────────────────────────────────────────
    const myDocsResult = (await db.execute(sql`
      WITH version_threads AS (
        SELECT v.document_id, t.id AS thread_id, t.resolved_at,
               GREATEST(t.created_at, COALESCE(t.resolved_at, t.created_at)) AS thread_activity
        FROM versions v
        LEFT JOIN threads t ON t.version_id = v.id
      ),
      version_comments AS (
        SELECT v.document_id,
               GREATEST(c.created_at,
                        COALESCE(c.updated_at, c.created_at),
                        COALESCE(c.deleted_at, c.created_at)) AS comment_activity
        FROM versions v
        LEFT JOIN threads t ON t.version_id = v.id
        LEFT JOIN comments c ON c.thread_id = t.id
      )
      SELECT
        d.id,
        d.title,
        d.description,
        u.display_name AS "uploaderDisplayName",
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL)::int AS "threadCount",
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL AND vt.resolved_at IS NULL)::int AS "activeThreadCount",
        GREATEST(
          d.created_at,
          COALESCE(MAX(vt.thread_activity), d.created_at),
          COALESCE(MAX(vc.comment_activity), d.created_at)
        ) AS "lastActivityAt"
      FROM documents d
      INNER JOIN users u ON u.id = d.uploader_id
      LEFT JOIN version_threads vt ON vt.document_id = d.id
      LEFT JOIN version_comments vc ON vc.document_id = d.id
      WHERE d.uploader_id = ${userId} AND d.deleted_at IS NULL
      GROUP BY d.id, d.title, d.description, u.display_name, d.created_at
      ORDER BY "lastActivityAt" DESC
    `)) as unknown as MyDocRow[];

    // ── Recently viewed or commented ───────────────────────────
    const activityResult = (await db.execute(sql`
      WITH viewed AS (
        SELECT dv.document_id, dv.viewed_at AS signal_at, 'viewed'::text AS signal
        FROM document_views dv
        WHERE dv.user_id = ${userId}
          AND dv.viewed_at > now() - interval '30 days'
      ),
      commented AS (
        SELECT v.document_id, MAX(c.created_at) AS signal_at, 'commented'::text AS signal
        FROM comments c
        INNER JOIN threads t ON t.id = c.thread_id
        INNER JOIN versions v ON v.id = t.version_id
        WHERE c.author_id = ${userId}
          AND c.created_at > now() - interval '30 days'
        GROUP BY v.document_id
      ),
      unioned AS (
        SELECT document_id, signal_at, signal FROM viewed
        UNION ALL
        SELECT document_id, signal_at, signal FROM commented
      ),
      latest AS (
        SELECT document_id,
               MAX(signal_at) AS signal_at,
               (ARRAY_AGG(signal ORDER BY signal_at DESC, signal DESC))[1] AS signal
        FROM unioned
        GROUP BY document_id
      )
      SELECT
        d.id,
        d.title,
        d.description,
        u.display_name AS "uploaderDisplayName",
        COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL)::int AS "threadCount",
        COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL AND t.resolved_at IS NULL)::int AS "activeThreadCount",
        latest.signal_at AS "lastActivityAt",
        latest.signal::text AS signal,
        latest.signal_at AS "signalAt"
      FROM latest
      INNER JOIN documents d ON d.id = latest.document_id AND d.deleted_at IS NULL
      INNER JOIN users u ON u.id = d.uploader_id
      LEFT JOIN versions v ON v.document_id = d.id
      LEFT JOIN threads t ON t.version_id = v.id
      GROUP BY d.id, d.title, d.description, u.display_name, latest.signal_at, latest.signal
      ORDER BY latest.signal_at DESC
    `)) as unknown as ActivityRow[];

    const myDocuments: DashboardDocumentSummary[] = myDocsResult.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      uploaderDisplayName: r.uploaderDisplayName,
      threadCount: toInt(r.threadCount),
      activeThreadCount: toInt(r.activeThreadCount),
      lastActivityAt: toIso(r.lastActivityAt),
    }));

    const recentlyViewedOrCommented: DashboardActivityEntry[] = activityResult.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      uploaderDisplayName: r.uploaderDisplayName,
      threadCount: toInt(r.threadCount),
      activeThreadCount: toInt(r.activeThreadCount),
      lastActivityAt: toIso(r.lastActivityAt),
      signal: r.signal,
      signalAt: toIso(r.signalAt),
    }));

    const body: DashboardResponse = { myDocuments, recentlyViewedOrCommented };
    return c.json(body, 200);
  });
}
