# Railway → dry-dock cutover

One-time move of Primer's data from the Railway backup into the GKE deployment
at `https://primer.polygon.tools`. Tracking: #103.

Context: Railway was compromised (INC-248, 2026-10-21). The Railway database and
storage volume were extracted on 2026-10-22, checksum- and size-verified, and
the Railway service stopped with its start command set to `sleep infinity`.
The backup lives outside the repo (`~/primer-recovery-20261022/`, encrypted
disk): `primer-20261022.dump` (pg_dump `-Fc`, PostgreSQL 18.6, sha256
`76053a6f908ab71361f52b6b7f366c402f8b0f90b18292ac18139eed80677619`) and
`storage/` (1,273 objects, one per `versions` row).

Names below in `<angle brackets>` come from the polygon-infrastructure change
that provisions the instance and buckets.

## Prerequisites

- [ ] Cloud SQL Postgres **18** instance `<instance>`, database `primer`, user `primer`.
- [ ] App bucket `<app-bucket>` (Primer objects) and a separate **staging bucket**
      `<staging-bucket>` the Cloud SQL instance's service account can read, for
      the import files. Do not put dumps in the app bucket.
- [ ] Secret Manager: `primer-database-url`, `primer-okta-client-secret`,
      `primer-mailgun-api-key` populated with **new** values (nothing reused from Railway).
- [ ] dry-dock Application synced with replicas at **0** (or not yet created), so
      nothing serves while data is loading.
- [ ] `gcloud` authenticated as someone with `cloudsql.instances.import` on the
      instance and write on both buckets.

## 1. Database

Cloud SQL's import takes plain SQL, so convert the custom-format dump locally.
`--no-owner --no-privileges` makes the import user (`primer`) own everything.

```sh
cd ~/primer-recovery-20261022
docker run --rm -v "$PWD":/w -w /w postgres:18 \
  pg_restore --no-owner --no-privileges -f primer-20261022.sql primer-20261022.dump

gcloud storage cp primer-20261022.sql gs://<staging-bucket>/cutover/
gcloud sql import sql <instance> gs://<staging-bucket>/cutover/primer-20261022.sql \
  --database=primer --user=primer
```

## 2. Invalidate credentials from the old database

Run `scripts/cutover/post-restore.sql` (idempotent, single transaction). It
deletes all sessions, revokes API tokens and OAuth refresh tokens, deletes OAuth
access tokens and unused auth/device codes, and expires external one-time codes.
Content tables are untouched.

```sh
gcloud storage cp scripts/cutover/post-restore.sql gs://<staging-bucket>/cutover/
gcloud sql import sql <instance> gs://<staging-bucket>/cutover/post-restore.sql \
  --database=primer --user=primer
```

The import does not print the post-condition counts; check them in step 4.

Share links (`external_shares.share_token`, plaintext) are deliberately left
working: viewing also needs an OTP emailed to an allowlisted recipient. To
rotate them anyway, see the commented statement at the end of the script.

## 3. Storage

Object names are the storage keys (`v1/<uuid>.html`).

```sh
gcloud storage cp -r ~/primer-recovery-20261022/storage/v1 gs://<app-bucket>/
gcloud storage ls gs://<app-bucket>/v1/ | wc -l   # expect 1273
```

## 4. Verify before taking traffic

From a pod in the cluster (or Cloud SQL Studio), against database `primer`:

```sql
select (select count(*) from users) users,        -- 181
       (select count(*) from documents) documents, -- 483
       (select count(*) from versions) versions,   -- 1273
       (select count(*) from comments) comments;   -- 910
select count(*) from sessions;                                   -- 0
select count(*) from api_tokens where revoked_at is null;        -- 0
select count(*) from oauth_access_tokens;                        -- 0
select count(*) from oauth_refresh_tokens where revoked_at is null; -- 0
```

## 5. Go live

1. Scale the Deployment up (dry-dock values) and wait for `/api/ready` to pass.
2. Smoke test at `https://primer.polygon.tools`: Okta sign-in, open a document,
   comment, live updates (SSE stays connected past 60s), create an API token,
   connect an MCP client (OAuth), open an external share link with an OTP.
3. Delete the import files from `<staging-bucket>`.
4. Announce the new URL. Old `primer-polygon.up.railway.app` links do not
   redirect; every user signs in again and MCP clients re-authorize.

## 6. After cutover

- Decommission the Railway project with the platform team. Keep the
  `primer-polygon.up.railway.app` domain reserved until then (takeover risk).
- Remove the SSH key the Railway CLI registered, and revoke the CLI token.
- Keep the local backup until the new deployment has its own Cloud SQL backups
  and has run cleanly for a week, then destroy it.
