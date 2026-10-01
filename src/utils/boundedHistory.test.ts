import { describe, expect, it } from "vitest";
import { pushBoundedHistory } from "./boundedHistory";

const item = (id: number, size: number) => ({ id, bytes: new Uint8Array(size) });

describe("pushBoundedHistory", () => {
  it("keeps the newest entries within the count limit", () => {
    const history = [item(1, 1), item(2, 1), item(3, 1)];
    expect(pushBoundedHistory(history, item(4, 1), 3, 100).map(({ id }) => id)).toEqual([2, 3, 4]);
  });

  it("drops the oldest entries until the byte budget fits", () => {
    const history = [item(1, 5), item(2, 6)];
    expect(pushBoundedHistory(history, item(3, 7), 8, 13).map(({ id }) => id)).toEqual([2, 3]);
  });

  it("keeps one oversized newest entry so undo remains possible", () => {
    expect(pushBoundedHistory([], item(1, 20), 8, 10).map(({ id }) => id)).toEqual([1]);
  });
});
