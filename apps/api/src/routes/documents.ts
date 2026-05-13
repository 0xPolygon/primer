import type { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { DocumentDetailResponse } from '@primer/shared/api';
import { documents, versions, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';

export function registerDocumentRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');

    const docRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        createdAt: documents.createdAt,
        uploaderDisplayName: users.displayName,
      })
      .from(documents)
      .innerJoin(users, eq(users.id, documents.uploaderId))
      .where(eq(documents.id, docId))
      .limit(1);

    if (docRows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const versionRows = await db
      .select()
      .from(versions)
      .where(eq(versions.documentId, docId))
      .orderBy(desc(versions.versionNumber))
      .limit(1);

    if (versionRows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const doc = docRows[0];
    const v = versionRows[0];

    const body: DocumentDetailResponse = {
      document: {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        uploaderDisplayName: doc.uploaderDisplayName,
        createdAt: doc.createdAt.toISOString(),
      },
      latestVersion: {
        id: v.id,
        versionNumber: v.versionNumber,
        versionNote: v.versionNote,
        sizeBytes: v.sizeBytes,
        createdAt: v.createdAt.toISOString(),
      },
    };
    return c.json(body, 200);
  });
}
