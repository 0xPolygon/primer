import { writeFile, mkdir, stat, unlink, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { Storage } from './types.ts';

export class FilesystemStorage implements Storage {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    const target = this.resolve(key);
    await mkdir(dirname(target), { recursive: true });
    // Written whole to a temp file, then linked into place: link fails if the
    // key exists, and the key never shows partial contents to a racing reader.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes);
      await link(temp, target);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      throw err;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.resolve(key);
    await stat(target); // throws ENOENT for missing files
    const nodeStream = createReadStream(target);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
  }

  private resolve(key: string): string {
    if (key.startsWith('/') || key.includes('..')) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return join(this.root, key);
  }
}
