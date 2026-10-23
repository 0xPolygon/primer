---
"@primer/api": patch
---

The GCS storage backend honours `STORAGE_EMULATOR_HOST`, so the image can run against a local GCS emulator. When it is set, requests go to the emulator and no access token is fetched from the GKE metadata server. It is meant for tests only; deployments leave it unset.
