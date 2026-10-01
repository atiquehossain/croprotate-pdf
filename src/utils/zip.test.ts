import { describe, expect, it } from "vitest";
import { createStoredZip } from "./zip";

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe("createStoredZip", () => {
  it("writes local, central-directory, and end records", () => {
    const bytes = createStoredZip([
      { name: "part-1.pdf", data: new Uint8Array([1, 2, 3]) },
      { name: "part-2.pdf", data: new Uint8Array([4, 5]) },
    ]);

    expect(u32(bytes, 0)).toBe(0x04034b50);
    const endOffset = bytes.byteLength - 22;
    expect(u32(bytes, endOffset)).toBe(0x06054b50);
    expect(u16(bytes, endOffset + 10)).toBe(2);
    const centralOffset = u32(bytes, endOffset + 16);
    expect(u32(bytes, centralOffset)).toBe(0x02014b50);
  });

  it("removes traversal segments from entry names", () => {
    const bytes = createStoredZip([
      { name: "../unsafe/../../safe.pdf", data: new Uint8Array([37, 80, 68, 70]) },
    ]);
    const nameLength = u16(bytes, 26);
    const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));

    expect(name).toBe("unsafe/safe.pdf");
    expect(name).not.toContain("..");
  });

  it("rejects an empty archive", () => {
    expect(() => createStoredZip([])).toThrow(/at least one/i);
  });
});
