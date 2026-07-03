import type { Hono } from 'hono';
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables } from '../app.ts';
import type { FolderDTO } from '@primer/shared';
import { folders, documentFolders } from '@primer/shared/schema';
import { db } from '../db/client.ts';

const MAX_NAME_LEN = 60;

function normalizeName(raw: unknown): { ok: true; name: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false };
  if (trimmed.length > MAX_NAME_LEN) return { ok: false };
  return { ok: true, name: trimmed };
}

function isDuplicateName(err: unknown): boolean {
  const e = err as { cause?: unknown; constraint_name?: string; code?: string };
  if (e?.constraint_name === 'folders_user_name_lower_unique') return true;
  const cause = e?.cause as { constraint_name?: string; code?: string } | undefined;
  if (cause?.constraint_name === 'folders_user_name_lower_unique') return true;
  // Fallback: stringify the full error chain
  return String(err).includes('folders_user_name_lower_unique');
}

async function loadCount(userId: string, folderId: string): Promise<number> {
  const [row] = await db.execute<{ count: number }>(drizzleSql`
    SELECT COUNT(*)::int AS count
      FROM document_folders
     WHERE user_id = ${userId}
       AND folder_id = ${folderId}
  `);
  return row?.count ?? 0;
}

export function registerFolderRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.post('/api/folders', async (c) => {
    const userId = c.get('user').id;
    const body = await c.req.json().catch(() => null);
    const normalized = normalizeName(body?.name);
    if (!normalized.ok) return c.json({ error: 'invalid_name' }, 400);

    const id = uuidv7();
    try {
      await db.insert(folders).values({
        id,
        userId,
        name: normalized.name,
      });
    } catch (err) {
      if (isDuplicateName(err)) {
        return c.json({ error: 'duplicate_name' }, 409);
      }
      throw err;
    }
    const dto: FolderDTO = { id, name: normalized.name, docCount: 0 };
    return c.json(dto, 201);
  });

  app.patch('/api/folders/:folderId', async (c) => {
    const userId = c.get('user').id;
    const folderId = c.req.param('folderId');
    const body = await c.req.json().catch(() => null);
    const normalized = normalizeName(body?.name);
    if (!normalized.ok) return c.json({ error: 'invalid_name' }, 400);

    const [existing] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    try {
      await db
        .update(folders)
        .set({ name: normalized.name, updatedAt: new Date() })
        .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
    } catch (err) {
      if (isDuplicateName(err)) {
        return c.json({ error: 'duplicate_name' }, 409);
      }
      throw err;
    }
    const docCount = await loadCount(userId, folderId);
    const dto: FolderDTO = { id: folderId, name: normalized.name, docCount };
    return c.json(dto, 200);
  });

  app.delete('/api/folders/:folderId', async (c) => {
    const userId = c.get('user').id;
    const folderId = c.req.param('folderId');
    const result = await db
      .delete(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, userId)))
      .returning({ id: folders.id });
    if (result.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.body(null, 204);
  });
}
