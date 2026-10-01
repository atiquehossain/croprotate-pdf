import { describe, expect, it } from "vitest";
import {
  HIGH_MEMORY_SPLIT_OUTPUT_BYTES,
  LOW_MEMORY_SPLIT_OUTPUT_BYTES,
  bytesToWholeMebibytes,
  splitOutputLimitBytes,
} from "./memoryLimits";

describe("splitOutputLimitBytes", () => {
  it("uses the conservative limit when device memory is unknown or modest", () => {
    expect(splitOutputLimitBytes()).toBe(LOW_MEMORY_SPLIT_OUTPUT_BYTES);
    expect(splitOutputLimitBytes(4)).toBe(LOW_MEMORY_SPLIT_OUTPUT_BYTES);
    expect(bytesToWholeMebibytes(LOW_MEMORY_SPLIT_OUTPUT_BYTES)).toBe(96);
  });

  it("allows the higher bounded limit on devices reporting at least 8 GiB", () => {
    expect(splitOutputLimitBytes(8)).toBe(HIGH_MEMORY_SPLIT_OUTPUT_BYTES);
    expect(splitOutputLimitBytes(16)).toBe(HIGH_MEMORY_SPLIT_OUTPUT_BYTES);
    expect(bytesToWholeMebibytes(HIGH_MEMORY_SPLIT_OUTPUT_BYTES)).toBe(128);
  });
});
