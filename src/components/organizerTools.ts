export type SelectionPreset = "all" | "odd" | "even" | "invert" | "clear";

export type SplitRequest =
  | { mode: "ranges"; rangeText: string }
  | { mode: "every"; everyN: number }
  | { mode: "each" };

export interface SplitGroup {
  /** A filesystem-safe suffix such as `pages-1-3`. */
  fileSuffix: string;
  /** Zero-based page indices in their visible document order. */
  pageIndices: number[];
  /** A concise label suitable for progress UI. */
  label: string;
}

export interface SplitPlan {
  mode: SplitRequest["mode"];
  groups: SplitGroup[];
}

export type SplitPlanResult =
  | { ok: true; plan: SplitPlan }
  | { ok: false; error: string };

/**
 * Produces a new selection in document order. Keeping this logic pure makes
 * keyboard shortcuts and toolbar controls behave identically.
 */
export function selectionForPreset(
  pageIds: readonly string[],
  selectedPageIds: ReadonlySet<string>,
  preset: SelectionPreset,
): string[] {
  switch (preset) {
    case "all":
      return [...pageIds];
    case "odd":
      return pageIds.filter((_, index) => index % 2 === 0);
    case "even":
      return pageIds.filter((_, index) => index % 2 === 1);
    case "invert":
      return pageIds.filter((pageId) => !selectedPageIds.has(pageId));
    case "clear":
      return [];
  }
}

/** Selects or clears an inclusive Shift-click range while preserving order. */
export function selectionWithRange(
  pageIds: readonly string[],
  selectedPageIds: ReadonlySet<string>,
  anchorIndex: number,
  targetIndex: number,
  select: boolean,
): string[] {
  const start = Math.max(0, Math.min(anchorIndex, targetIndex));
  const end = Math.min(pageIds.length - 1, Math.max(anchorIndex, targetIndex));
  const next = new Set(selectedPageIds);
  for (let index = start; index <= end; index += 1) {
    if (select) next.add(pageIds[index]);
    else next.delete(pageIds[index]);
  }
  return pageIds.filter((pageId) => next.has(pageId));
}

/**
 * Returns the insertion slot in the unselected-page list that moves a
 * selection one visual step while keeping selected pages together.
 */
export function blockInsertionForDirection(
  pageIds: readonly string[],
  selectedPageIds: ReadonlySet<string>,
  direction: "earlier" | "later",
): number | null {
  const selectedIndices = pageIds
    .map((pageId, index) => selectedPageIds.has(pageId) ? index : -1)
    .filter((index) => index >= 0);
  if (!selectedIndices.length || selectedIndices.length === pageIds.length) return null;

  const firstSelected = selectedIndices[0];
  const currentSlot = pageIds
    .slice(0, firstSelected)
    .filter((pageId) => !selectedPageIds.has(pageId)).length;
  const remainingCount = pageIds.length - selectedIndices.length;
  const nextSlot = direction === "earlier" ? currentSlot - 1 : currentSlot + 1;
  const boundedSlot = Math.max(0, Math.min(remainingCount, nextSlot));
  return boundedSlot === currentSlot ? null : boundedSlot;
}

/** Rebuilds page IDs by inserting the selected pages into the remaining list. */
export function reorderSelectionAsBlock(
  pageIds: readonly string[],
  selectedPageIds: ReadonlySet<string>,
  insertionIndex: number,
): string[] {
  const selected = pageIds.filter((pageId) => selectedPageIds.has(pageId));
  const remaining = pageIds.filter((pageId) => !selectedPageIds.has(pageId));
  const slot = Math.max(0, Math.min(remaining.length, insertionIndex));
  return [...remaining.slice(0, slot), ...selected, ...remaining.slice(slot)];
}

/** Calculates a natural before/after slot when a selected block is dropped. */
export function blockDropInsertion(
  pageIds: readonly string[],
  selectedPageIds: ReadonlySet<string>,
  targetPageId: string,
): number | null {
  if (selectedPageIds.has(targetPageId)) return null;
  const targetIndex = pageIds.indexOf(targetPageId);
  if (targetIndex < 0) return null;
  const selectedIndices = pageIds
    .map((pageId, index) => selectedPageIds.has(pageId) ? index : -1)
    .filter((index) => index >= 0);
  if (!selectedIndices.length) return null;
  const remaining = pageIds.filter((pageId) => !selectedPageIds.has(pageId));
  const targetRemainingIndex = remaining.indexOf(targetPageId);
  const movingForward = targetIndex > selectedIndices[selectedIndices.length - 1];
  return targetRemainingIndex + (movingForward ? 1 : 0);
}

function rangeGroup(start: number, end: number): SplitGroup {
  const pageIndices = Array.from({ length: end - start + 1 }, (_, index) => start - 1 + index);
  const label = start === end ? `Page ${start}` : `Pages ${start}–${end}`;
  return {
    pageIndices,
    label,
    fileSuffix: start === end ? `page-${start}` : `pages-${start}-${end}`,
  };
}

/**
 * Validates a split request and resolves it to explicit zero-based groups.
 * Range mode intentionally creates one output PDF per comma-separated item.
 */
export function buildSplitPlan(request: SplitRequest, pageCount: number): SplitPlanResult {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { ok: false, error: "Open a PDF before creating a split." };
  }

  if (request.mode === "each") {
    return {
      ok: true,
      plan: {
        mode: request.mode,
        groups: Array.from({ length: pageCount }, (_, index) => rangeGroup(index + 1, index + 1)),
      },
    };
  }

  if (request.mode === "every") {
    if (!Number.isInteger(request.everyN) || request.everyN < 1) {
      return { ok: false, error: "Enter a whole number of pages, starting at 1." };
    }
    if (request.everyN > pageCount) {
      return { ok: false, error: `This PDF has ${pageCount} page${pageCount === 1 ? "" : "s"}. Choose ${pageCount} or fewer.` };
    }
    const groups: SplitGroup[] = [];
    for (let start = 1; start <= pageCount; start += request.everyN) {
      groups.push(rangeGroup(start, Math.min(pageCount, start + request.everyN - 1)));
    }
    return { ok: true, plan: { mode: request.mode, groups } };
  }

  const input = request.rangeText.trim();
  if (!input) {
    return { ok: false, error: "Enter at least one page or range, such as 1-3, 6, 9-end." };
  }
  const tokens = input.split(",").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) {
    return { ok: false, error: "Remove the empty range between commas." };
  }
  if (tokens.length > pageCount) {
    return { ok: false, error: `Use at most ${pageCount} range${pageCount === 1 ? "" : "s"} for this PDF.` };
  }

  const groups: SplitGroup[] = [];
  const seenRanges = new Set<string>();
  for (const token of tokens) {
    const match = /^(\d+)(?:\s*-\s*(\d+|end))?$/i.exec(token);
    if (!match) {
      return { ok: false, error: `“${token}” is not a valid range. Try 1-3, 6, 9-end.` };
    }
    const start = Number.parseInt(match[1], 10);
    const end = match[2]?.toLowerCase() === "end"
      ? pageCount
      : Number.parseInt(match[2] ?? match[1], 10);
    if (start < 1 || start > pageCount || end < 1 || end > pageCount) {
      return { ok: false, error: `“${token}” is outside this ${pageCount}-page PDF.` };
    }
    if (start > end) {
      return { ok: false, error: `“${token}” runs backwards. Put the smaller page first.` };
    }
    const signature = `${start}-${end}`;
    if (seenRanges.has(signature)) {
      return { ok: false, error: `“${token}” repeats an earlier range.` };
    }
    seenRanges.add(signature);
    groups.push(rangeGroup(start, end));
  }

  return { ok: true, plan: { mode: request.mode, groups } };
}
