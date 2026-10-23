import { FilesystemStorage } from './filesystem.ts';
import { GcsStorage } from './gcs.ts';
import type { Storage } from './types.ts';

export type StorageDescription =
  | { backend: 'filesystem'; root: string }
  | { backend: 'gcs'; bucket: string; emulator?: string };

// STORAGE_BACKEND=gcs (production on GKE) or filesystem (default; local dev).
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): {
  storage: Storage;
  description: StorageDescription;
} {
  const backend = (env.STORAGE_BACKEND ?? 'filesystem').toLowerCase();
  if (backend === 'gcs') {
    const bucket = env.GCS_BUCKET;
    if (!bucket) throw new Error('GCS_BUCKET is required when STORAGE_BACKEND=gcs');
    // STORAGE_EMULATOR_HOST is the Google client libraries' switch for a local
    // GCS emulator (the release gate runs fake-gcs-server). Outside GKE there is
    // no metadata server to mint tokens, and the emulator ignores credentials,
    // so a placeholder token stands in. Never set in a deployment.
    const emulator = env.STORAGE_EMULATOR_HOST;
    if (emulator) {
      const apiBaseUrl = /^https?:\/\//.test(emulator) ? emulator : `http://${emulator}`;
      return {
        storage: new GcsStorage({ bucket, apiBaseUrl, getAccessToken: () => Promise.resolve('emulator') }),
        description: { backend: 'gcs', bucket, emulator: apiBaseUrl },
      };
    }
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
