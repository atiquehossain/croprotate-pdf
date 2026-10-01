import { describe, expect, it } from "vitest";
import {
  blockDropInsertion,
  blockInsertionForDirection,
  buildSplitPlan,
  reorderSelectionAsBlock,
  selectionForPreset,
  selectionWithRange,
} from "./organizerTools";

const ids = ["a", "b", "c", "d", "e", "f"];

describe("organizer selection tools", () => {
  it("selects odd, even, inverted, and ordered pages", () => {
    expect(selectionForPreset(ids, new Set(["b", "e"]), "odd")).toEqual(["a", "c", "e"]);
    expect(selectionForPreset(ids, new Set(["b", "e"]), "even")).toEqual(["b", "d", "f"]);
    expect(selectionForPreset(ids, new Set(["b", "e"]), "invert")).toEqual(["a", "c", "d", "f"]);
    expect(selectionForPreset(ids, new Set(), "all")).toEqual(ids);
  });

  it("adds and removes inclusive shift-click ranges", () => {
    expect(selectionWithRange(ids, new Set(["a"]), 1, 4, true)).toEqual(["a", "b", "c", "d", "e"]);
    expect(selectionWithRange(ids, new Set(ids), 4, 2, false)).toEqual(["a", "b", "f"]);
  });

  it("moves non-contiguous selections together without changing their order", () => {
    const selection = new Set(["b", "d"]);
    expect(blockInsertionForDirection(ids, selection, "earlier")).toBe(0);
    expect(blockInsertionForDirection(ids, selection, "later")).toBe(2);
    expect(reorderSelectionAsBlock(ids, selection, 2)).toEqual(["a", "c", "b", "d", "e", "f"]);
    expect(blockDropInsertion(ids, selection, "f")).toBe(4);
  });

  it("disables block movement at document boundaries", () => {
    expect(blockInsertionForDirection(ids, new Set(["a", "b"]), "earlier")).toBeNull();
    expect(blockInsertionForDirection(ids, new Set(["e", "f"]), "later")).toBeNull();
    expect(blockDropInsertion(ids, new Set(["b", "d"]), "b")).toBeNull();
  });
});

describe("split planning", () => {
  it("creates a file for each explicit range and supports end", () => {
    const result = buildSplitPlan({ mode: "ranges", rangeText: "1-3, 6, 9-end" }, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups.map((group) => group.pageIndices)).toEqual([
      [0, 1, 2],
      [5],
      [8, 9],
    ]);
    expect(result.plan.groups.map((group) => group.fileSuffix)).toEqual([
      "pages-1-3",
      "page-6",
      "pages-9-10",
    ]);
  });

  it("chunks a document every N pages", () => {
    const result = buildSplitPlan({ mode: "every", everyN: 3 }, 8);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups.map((group) => group.pageIndices)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7],
    ]);
  });

  it("creates one group per page", () => {
    const result = buildSplitPlan({ mode: "each" }, 3);
    expect(result.ok && result.plan.groups).toHaveLength(3);
  });

  it("returns human-friendly range errors", () => {
    expect(buildSplitPlan({ mode: "ranges", rangeText: "5-2" }, 6)).toEqual({
      ok: false,
      error: "“5-2” runs backwards. Put the smaller page first.",
    });
    expect(buildSplitPlan({ mode: "ranges", rangeText: "7" }, 6)).toEqual({
      ok: false,
      error: "“7” is outside this 6-page PDF.",
    });
    expect(buildSplitPlan({ mode: "every", everyN: 0 }, 6).ok).toBe(false);
    expect(buildSplitPlan({ mode: "ranges", rangeText: "1-2, 1-2" }, 6)).toEqual({
      ok: false,
      error: "“1-2” repeats an earlier range.",
    });
  });
});
