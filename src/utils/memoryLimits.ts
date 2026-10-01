const MEBIBYTE = 1024 * 1024;

export const LOW_MEMORY_SPLIT_OUTPUT_BYTES = 96 * MEBIBYTE;
export const HIGH_MEMORY_SPLIT_OUTPUT_BYTES = 128 * MEBIBYTE;

/**
 * ZIP creation temporarily needs both the exported PDFs and an equally large
 * output buffer. Only devices that explicitly report ample memory receive the
 * higher cap; unknown and lower-memory devices use the safer default.
 */
export function splitOutputLimitBytes(deviceMemoryGiB?: number): number {
  return typeof deviceMemoryGiB === "number" &&
    Number.isFinite(deviceMemoryGiB) &&
    deviceMemoryGiB >= 8
    ? HIGH_MEMORY_SPLIT_OUTPUT_BYTES
    : LOW_MEMORY_SPLIT_OUTPUT_BYTES;
}

export function bytesToWholeMebibytes(bytes: number): number {
  return Math.round(bytes / MEBIBYTE);
}
