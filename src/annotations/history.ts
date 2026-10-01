import { cloneAnnotationDocument } from "./model";
import type { Annotation, AnnotationDocument } from "./types";

export interface AnnotationHistoryOptions {
  /** Maximum undo or redo snapshots retained. */
  maxEntries?: number;
  /** Approximate scalar/character budget across either history direction. */
  maxCost?: number;
}

export interface AnnotationHistory {
  past: AnnotationDocument[];
  present: AnnotationDocument;
  future: AnnotationDocument[];
  maxEntries: number;
  maxCost: number;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_COST = 250_000;

function annotationCost(annotation: Annotation): number {
  const labelCost = annotation.label?.length ?? 0;
  switch (annotation.kind) {
    case "ink":
      return 16 + labelCost + annotation.strokes.reduce(
        (total, stroke) => total + 1 + stroke.length * 3,
        0,
      );
    case "highlight":
      return 16 + labelCost + annotation.points.length * 3;
    case "text":
      return 24 + labelCost + annotation.text.length;
    case "mark":
    case "shape":
      return 20 + labelCost;
    case "line":
      return 18 + labelCost;
  }
}

/** A deterministic, inexpensive estimate used only to cap in-memory history. */
export function estimateAnnotationDocumentCost(document: AnnotationDocument): number {
  return Object.entries(document.pages).reduce(
    (total, [pageId, annotations]) =>
      total + pageId.length + annotations.reduce((sum, annotation) => sum + annotationCost(annotation), 0),
    1,
  );
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : fallback));
}

function trimSnapshots(
  snapshots: readonly AnnotationDocument[],
  maxEntries: number,
  maxCost: number,
  keepNewestAtEnd: boolean,
): AnnotationDocument[] {
  if (maxEntries === 0) return [];
  const ordered = keepNewestAtEnd
    ? snapshots.slice(-maxEntries)
    : snapshots.slice(0, maxEntries);
  let total = ordered.reduce((sum, item) => sum + estimateAnnotationDocumentCost(item), 0);
  while (ordered.length > 1 && total > maxCost) {
    const index = keepNewestAtEnd ? 0 : ordered.length - 1;
    const [removed] = ordered.splice(index, 1);
    total -= estimateAnnotationDocumentCost(removed);
  }
  return ordered;
}

export function createAnnotationHistory(
  initial: AnnotationDocument,
  options: AnnotationHistoryOptions = {},
): AnnotationHistory {
  return {
    past: [],
    present: cloneAnnotationDocument(initial),
    future: [],
    maxEntries: normalizeLimit(options.maxEntries, DEFAULT_MAX_ENTRIES),
    maxCost: normalizeLimit(options.maxCost, DEFAULT_MAX_COST),
  };
}

/** Commit one complete interaction (for example, a finished pen stroke or drag). */
export function commitAnnotationHistory(
  history: AnnotationHistory,
  next: AnnotationDocument,
): AnnotationHistory {
  if (next === history.present) return history;
  const past = trimSnapshots(
    [...history.past, cloneAnnotationDocument(history.present)],
    history.maxEntries,
    history.maxCost,
    true,
  );
  return {
    ...history,
    past,
    present: cloneAnnotationDocument(next),
    future: [],
  };
}

export function undoAnnotationHistory(history: AnnotationHistory): AnnotationHistory {
  if (!history.past.length) return history;
  const previous = history.past[history.past.length - 1];
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: cloneAnnotationDocument(previous),
    future: trimSnapshots(
      [cloneAnnotationDocument(history.present), ...history.future],
      history.maxEntries,
      history.maxCost,
      false,
    ),
  };
}

export function redoAnnotationHistory(history: AnnotationHistory): AnnotationHistory {
  if (!history.future.length) return history;
  const [next, ...future] = history.future;
  return {
    ...history,
    past: trimSnapshots(
      [...history.past, cloneAnnotationDocument(history.present)],
      history.maxEntries,
      history.maxCost,
      true,
    ),
    present: cloneAnnotationDocument(next),
    future,
  };
}

export function resetAnnotationHistory(
  history: AnnotationHistory,
  next: AnnotationDocument,
): AnnotationHistory {
  return {
    ...history,
    past: [],
    present: cloneAnnotationDocument(next),
    future: [],
  };
}

export function canUndoAnnotations(history: AnnotationHistory): boolean {
  return history.past.length > 0;
}

export function canRedoAnnotations(history: AnnotationHistory): boolean {
  return history.future.length > 0;
}
