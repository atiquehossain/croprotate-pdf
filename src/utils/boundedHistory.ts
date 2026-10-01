interface ByteSnapshot {
  bytes: Uint8Array;
}

/** Keeps newest undo points while enforcing both count and memory limits. */
export function pushBoundedHistory<T extends ByteSnapshot>(
  history: readonly T[],
  snapshot: T,
  maxEntries = 8,
  maxBytes = 160 * 1024 * 1024,
): T[] {
  const next = [...history, snapshot].slice(-Math.max(1, maxEntries));
  let totalBytes = next.reduce((total, item) => total + item.bytes.byteLength, 0);
  while (next.length > 1 && totalBytes > maxBytes) {
    totalBytes -= next[0].bytes.byteLength;
    next.shift();
  }
  return next;
}
