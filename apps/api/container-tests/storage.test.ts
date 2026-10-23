import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Runs only in container mode (see vitest.config.ts). The release gate boots
// the image on STORAGE_BACKEND=gcs against fake-gcs-server, so this proves the
// image's write and read paths reach GCS. Nothing here imports the app: the
// API token is seeded straight into the image's database (the only way in
// without an Okta login), and the object is read back from the emulator
// directly so a filesystem fallback could not pass.
//
// The SMOKE_* overrides exist for the local simulation, where the test runner
// reaches Postgres and the emulator on different hosts than the container does.
const baseUrl = process.env.TEST_BASE_URL;
const databaseUrl = process.env.SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;
const emulator = process.env.SMOKE_STORAGE_EMULATOR_HOST ?? process.env.STORAGE_EMULATOR_HOST;
const bucket = process.env.GCS_BUCKET;
const gcsMode = process.env.STORAGE_BACKEND === 'gcs';

describe.skipIf(!gcsMode)('container storage (GCS emulator)', () => {
  let sql!: postgres.Sql;
  let token!: string;

  beforeAll(async () => {
    if (!baseUrl || !databaseUrl || !emulator || !bucket) {
      throw new Error('GCS smoke needs TEST_BASE_URL, DATABASE_URL, STORAGE_EMULATOR_HOST and GCS_BUCKET');
    }
    sql = postgres(databaseUrl, { max: 1 });
    const userId = `smoke-gcs-${randomUUID()}`;
    const random = randomBytes(32).toString('base64url');
    token = `primer_pat_${random}`;
    await sql`insert into users (id, email, display_name) values (${userId}, ${`${userId}@smoke.invalid`}, 'GCS smoke')`;
    await sql`
      insert into api_tokens (id, user_id, name, token_hash, token_prefix)
      values (${randomUUID()}, ${userId}, 'gcs smoke', ${createHash('sha256').update(token).digest('hex')}, ${random.slice(0, 8)})
    `;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('stores an upload in the bucket and serves it back', async () => {
    const marker = `gcs-smoke-${randomUUID()}`;
    const form = new FormData();
    form.set('title', 'GCS smoke');
    form.set('file', new File([`# ${marker}\n`], 'smoke.md', { type: 'text/markdown' }));
    const auth = { authorization: `Bearer ${token}` };

    const upload = await fetch(new URL('/api/upload', baseUrl), { method: 'POST', body: form, headers: auth, redirect: 'manual' });
    expect(upload.status).equal(200);
    const { versionId } = (await upload.json()) as { versionId: string };

    const content = await fetch(new URL(`/api/versions/${versionId}/content`, baseUrl), { headers: auth, redirect: 'manual' });
    expect(content.status).equal(200);
    expect(await content.text()).include(marker);

    const object = await fetch(
      `${emulator}/storage/v1/b/${bucket}/o/${encodeURIComponent(`v1/${versionId}.html`)}?alt=media`,
    );
    expect(object.status).equal(200);
    expect(await object.text()).include(marker);
  });
});
