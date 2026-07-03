import { sql } from '../db/client.ts';
import { afterAll, beforeEach } from 'vitest';

beforeEach(async () => {
  // Wipe transactional tables between tests; keep the seeded mock user row.
  await sql`truncate table document_collaborators, document_views, comments, threads, versions, documents, document_folders, folders restart identity cascade`;
  // Wipe sessions and non-mock users so session tests start clean.
  await sql`truncate table sessions restart identity cascade`;
  await sql`delete from users where id != 'mock-user-1'`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
