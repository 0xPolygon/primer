// Writes a new version row, carries the document's open threads onto it and
// emits `primer.version.published`, all in one transaction. Shared by the REST
// route (routes/documents.ts) and the MCP tool (mcp/tools.ts) so the two
// publish paths can't drift. Carried placements emit no event of their own:
// they are part of the version, and a reader that sees version.published
// lists the new version's threads.
import { versions } from '../db/schema.ts';
import type { Storage } from '../storage/types.ts';
import { transactionWithEvents } from './events.ts';
import { carryOpenThreads, type BodyText } from './threadCarry.ts';

export async function insertPublishedVersion(
  storage: Storage,
  args: {
    documentId: string;
    versionId: string;
    versionNumber: number;
    storageKey: string;
    sizeBytes: number;
    versionNote: string | null;
    html: string;
    origins: Map<string, BodyText>;
    actorId: string;
  },
): Promise<void> {
  const { documentId, versionId, versionNumber, actorId } = args;
  await transactionWithEvents(async (tx, emit) => {
    await tx.insert(versions).values({
      id: versionId,
      documentId,
      versionNumber,
      storageKey: args.storageKey,
      sizeBytes: args.sizeBytes,
      versionNote: args.versionNote,
    });
    await carryOpenThreads(tx, storage, { documentId, versionId, html: args.html, origins: args.origins });
    emit({
      documentId,
      versionId,
      actorId,
      type: 'version.published',
      payload: { document_id: documentId, version_id: versionId, number: versionNumber, author_id: actorId },
    });
  });
}
