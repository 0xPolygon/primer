---
"@primer/api": patch
---

Add a Google Cloud Storage backend for document storage, so Primer can run
stateless on GKE. Set `STORAGE_BACKEND=gcs` and `GCS_BUCKET`; the default stays
the filesystem (`STORAGE_ROOT`), so local dev is unchanged.

It talks to the GCS JSON API over `fetch` and authenticates with Workload
Identity tokens from the GKE metadata server, so it adds no dependencies and
the pod holds no key file. Object names are the existing storage keys, so a
copy of the filesystem root into the bucket is a valid migration. A missing
object rejects with `ENOENT` like the filesystem backend; deleting one is a
no-op.
