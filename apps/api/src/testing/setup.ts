import { sql } from '../db/client.ts';
import { afterAll, beforeEach } from 'vitest';

beforeEach(async () => {
  // Wipe transactional tables between tests; keep the seeded mock user row.
  await sql`truncate table document_views, comments, threads, versions, documents restart identity cascade`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
