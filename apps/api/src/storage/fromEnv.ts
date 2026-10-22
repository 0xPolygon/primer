import { FilesystemStorage } from './filesystem.ts';
import { GcsStorage } from './gcs.ts';
import type { Storage } from './types.ts';

export type StorageDescription =
  | { backend: 'filesystem'; root: string }
  | { backend: 'gcs'; bucket: string };

// STORAGE_BACKEND=gcs (production on GKE) or filesystem (default; local dev).
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): {
  storage: Storage;
  description: StorageDescription;
} {
  const backend = (env.STORAGE_BACKEND ?? 'filesystem').toLowerCase();
  if (backend === 'gcs') {
    const bucket = env.GCS_BUCKET;
    if (!bucket) throw new Error('GCS_BUCKET is required when STORAGE_BACKEND=gcs');
    return {
      storage: new GcsStorage({ bucket, apiBaseUrl: env.GCS_API_BASE_URL }),
      description: { backend: 'gcs', bucket },
    };
  }
  if (backend !== 'filesystem') {
    throw new Error(`unknown STORAGE_BACKEND: ${env.STORAGE_BACKEND}`);
  }
  const root = env.STORAGE_ROOT ?? './storage';
  return { storage: new FilesystemStorage(root), description: { backend: 'filesystem', root } };
}
