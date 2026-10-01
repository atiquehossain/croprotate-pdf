export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipProgress {
  completed: number;
  total: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) !== 0
        ? 0xedb88320 ^ (current >>> 1)
        : current >>> 1;
    }
    table[value] = current >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}

function writeU32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

function safeEntryName(name: string): string {
  const normalized = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
  return normalized || "document.pdf";
}

/**
 * Build a standards-compliant ZIP archive using the STORE method.
 * PDF streams are commonly compressed already, so avoiding a second compression pass
 * keeps this fast, deterministic, and dependency-free in the browser.
 */
export function createStoredZip(
  entries: readonly ZipEntry[],
  onProgress?: (progress: ZipProgress) => void,
): Uint8Array<ArrayBuffer> {
  if (entries.length === 0) throw new Error("A ZIP archive needs at least one file.");
  if (entries.length > 0xffff) throw new Error("This ZIP archive has too many files.");

  const encoder = new TextEncoder();
  const prepared = entries.map((entry, index) => {
    const name = encoder.encode(safeEntryName(entry.name));
    if (name.byteLength > 0xffff) throw new Error("A ZIP filename is too long.");
    if (entry.data.byteLength > 0xffffffff) throw new Error("A ZIP file is larger than 4 GB.");
    const preparedEntry = { name, data: entry.data, crc: crc32(entry.data) };
    onProgress?.({ completed: index + 1, total: entries.length });
    return preparedEntry;
  });

  const localSize = prepared.reduce(
    (total, entry) => total + 30 + entry.name.byteLength + entry.data.byteLength,
    0,
  );
  const centralSize = prepared.reduce(
    (total, entry) => total + 46 + entry.name.byteLength,
    0,
  );
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xffffffff) throw new Error("This ZIP archive would be larger than 4 GB.");

  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  const localOffsets: number[] = [];
  let offset = 0;

  for (const entry of prepared) {
    localOffsets.push(offset);
    offset = writeU32(view, offset, 0x04034b50);
    offset = writeU16(view, offset, 20);
    offset = writeU16(view, offset, 0x0800); // UTF-8 filename.
    offset = writeU16(view, offset, 0); // STORE (PDF streams are already compressed).
    offset = writeU16(view, offset, 0); // Deterministic DOS time.
    offset = writeU16(view, offset, 0); // Deterministic DOS date.
    offset = writeU32(view, offset, entry.crc);
    offset = writeU32(view, offset, entry.data.byteLength);
    offset = writeU32(view, offset, entry.data.byteLength);
    offset = writeU16(view, offset, entry.name.byteLength);
    offset = writeU16(view, offset, 0);
    output.set(entry.name, offset);
    offset += entry.name.byteLength;
    output.set(entry.data, offset);
    offset += entry.data.byteLength;
  }

  const centralOffset = offset;
  prepared.forEach((entry, index) => {
    offset = writeU32(view, offset, 0x02014b50);
    offset = writeU16(view, offset, 20);
    offset = writeU16(view, offset, 20);
    offset = writeU16(view, offset, 0x0800);
    offset = writeU16(view, offset, 0);
    offset = writeU16(view, offset, 0);
    offset = writeU16(view, offset, 0);
    offset = writeU32(view, offset, entry.crc);
    offset = writeU32(view, offset, entry.data.byteLength);
    offset = writeU32(view, offset, entry.data.byteLength);
    offset = writeU16(view, offset, entry.name.byteLength);
    offset = writeU16(view, offset, 0);
    offset = writeU16(view, offset, 0);
    offset = writeU16(view, offset, 0);
    offset = writeU16(view, offset, 0);
    offset = writeU32(view, offset, 0);
    offset = writeU32(view, offset, localOffsets[index]);
    output.set(entry.name, offset);
    offset += entry.name.byteLength;
  });

  const writtenCentralSize = offset - centralOffset;
  offset = writeU32(view, offset, 0x06054b50);
  offset = writeU16(view, offset, 0);
  offset = writeU16(view, offset, 0);
  offset = writeU16(view, offset, prepared.length);
  offset = writeU16(view, offset, prepared.length);
  offset = writeU32(view, offset, writtenCentralSize);
  offset = writeU32(view, offset, centralOffset);
  writeU16(view, offset, 0);

  return output;
}
