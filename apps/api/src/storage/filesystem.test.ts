import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemStorage } from './filesystem.ts';

let root: string;
let storage: FilesystemStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'primer-storage-test-'));
  storage = new FilesystemStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FilesystemStorage.put', () => {
  it('writes bytes under the configured root, creating parent dirs', async () => {
    const bytes = new TextEncoder().encode('<html></html>');
    await storage.put('v1/abc.html', bytes);

    const onDisk = await readFile(join(root, 'v1/abc.html'));
    expect(onDisk).toEqual(Buffer.from(bytes));
  });

  it('overwrites an existing file at the same key', async () => {
    await storage.put('v1/abc.html', new TextEncoder().encode('first'));
    await storage.put('v1/abc.html', new TextEncoder().encode('second'));

    const onDisk = await readFile(join(root, 'v1/abc.html'), 'utf8');
    expect(onDisk).toBe('second');
  });

  it('rejects unsafe keys (absolute paths or .. traversal)', async () => {
    await expect(storage.put('/abc.html', new Uint8Array())).rejects.toThrow();
    await expect(storage.put('../escape.html', new Uint8Array())).rejects.toThrow();
  });
});

describe('FilesystemStorage.get', () => {
  it('returns a ReadableStream of the file contents', async () => {
    const bytes = new TextEncoder().encode('<h1>hi</h1>');
    await storage.put('v1/abc.html', bytes);

    const stream = await storage.get('v1/abc.html');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(merged.toString('utf8')).toBe('<h1>hi</h1>');
  });

  it('throws on missing key', async () => {
    await expect(storage.get('v1/nope.html')).rejects.toThrow();
  });
});

describe('FilesystemStorage.delete', () => {
  it('removes the file at the key', async () => {
    await storage.put('v1/abc.html', new TextEncoder().encode('x'));
    await storage.delete('v1/abc.html');
    await expect(access(join(root, 'v1/abc.html'))).rejects.toThrow();
  });

  it('does not throw when the key is missing (idempotent best-effort delete)', async () => {
    await expect(storage.delete('v1/nope.html')).resolves.toBeUndefined();
  });
});

describe('FilesystemStorage.putIfAbsent', () => {
  it('writes once and reports the existing key on the second try', async () => {
    const storage = new FilesystemStorage(root);
    expect(await storage.putIfAbsent('keys/k', new Uint8Array([1]))).toBe(true);
    expect(await storage.putIfAbsent('keys/k', new Uint8Array([2]))).toBe(false);
    expect(Array.from(new Uint8Array(await new Response(await storage.get('keys/k')).arrayBuffer()))).toEqual([1]);
  });
});
