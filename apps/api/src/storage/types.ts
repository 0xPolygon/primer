export interface Storage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Writes only if the key does not exist. Returns false when it already does. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
}

export type StorageKey = string;
