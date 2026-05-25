export interface MessageBuffer<T> {
  enqueue(item: T): void;
  drain(sink: (item: T) => void): void;
  size(): number;
}

export function createMessageBuffer<T>(cap: number): MessageBuffer<T> {
  const items: T[] = [];
  return {
    enqueue(item) {
      items.push(item);
      while (items.length > cap) items.shift();
    },
    drain(sink) {
      while (items.length > 0) {
        const next = items.shift()!;
        sink(next);
      }
    },
    size() {
      return items.length;
    },
  };
}
