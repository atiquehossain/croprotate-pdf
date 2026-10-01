import {
  hitTestAnnotations,
  moveAnnotation,
  normalizeAnnotationRect,
  type AnnotationHitTestOptions,
  type AnnotationViewportTransform,
} from "./geometry";
import type {
  Annotation,
  AnnotationDocument,
  AnnotationId,
  AnnotationPageId,
  AnnotationPoint,
  AnnotationRect,
} from "./types";

export type AnnotationIdFactory = (source: Annotation, duplicateIndex: number) => AnnotationId;
export type AnnotationUpdater = (annotation: Annotation) => Annotation;

export interface EraseResult {
  document: AnnotationDocument;
  erasedIds: AnnotationId[];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function normalizePoint(point: AnnotationPoint): AnnotationPoint {
  const pressure = point.pressure === undefined
    ? undefined
    : clamp(requireFinite(point.pressure, "Annotation pressure"));
  return {
    x: clamp(requireFinite(point.x, "Annotation x coordinate")),
    y: clamp(requireFinite(point.y, "Annotation y coordinate")),
    ...(pressure === undefined ? {} : { pressure }),
  };
}

function normalizeRectToPage(rect: AnnotationRect): AnnotationRect {
  const normalized = normalizeAnnotationRect({
    x: requireFinite(rect.x, "Annotation rectangle x"),
    y: requireFinite(rect.y, "Annotation rectangle y"),
    width: requireFinite(rect.width, "Annotation rectangle width"),
    height: requireFinite(rect.height, "Annotation rectangle height"),
  });
  const left = clamp(normalized.x);
  const bottom = clamp(normalized.y);
  const right = clamp(normalized.x + normalized.width);
  const top = clamp(normalized.y + normalized.height);
  if (right <= left || top <= bottom) {
    throw new Error("Annotation rectangle must have a positive area inside its page.");
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

function normalizedBase<T extends Annotation>(annotation: T): T {
  if (!annotation.id.trim()) throw new Error("Annotation ID cannot be empty.");
  if (!annotation.pageId.trim()) throw new Error("Annotation page ID cannot be empty.");
  const width = requireFinite(annotation.width, "Annotation stroke width");
  if (width < 0) throw new Error("Annotation stroke width cannot be negative.");
  return {
    ...annotation,
    color: annotation.color.trim() || "#111111",
    opacity: clamp(requireFinite(annotation.opacity, "Annotation opacity")),
    width,
  };
}

/** Validate, clamp and deep-clone an annotation at a model boundary. */
export function normalizeAnnotation(annotation: Annotation): Annotation {
  const base = normalizedBase(annotation);
  switch (base.kind) {
    case "ink": {
      const strokes = base.strokes.filter((stroke) => stroke.length > 0);
      if (!strokes.length) throw new Error("An ink annotation needs at least one stroke point.");
      return { ...base, strokes: strokes.map((stroke) => stroke.map(normalizePoint)) };
    }
    case "highlight":
      if (!base.points.length) throw new Error("A stroke needs at least one point.");
      return { ...base, points: base.points.map(normalizePoint) };
    case "text": {
      const fontSize = requireFinite(base.fontSize, "Annotation font size");
      if (fontSize <= 0) throw new Error("Annotation font size must be positive.");
      if (!base.text) throw new Error("A text annotation cannot be empty.");
      return { ...base, rect: normalizeRectToPage(base.rect), fontSize };
    }
    case "mark":
      return { ...base, rect: normalizeRectToPage(base.rect) };
    case "line": {
      const start = normalizePoint(base.start);
      const end = normalizePoint(base.end);
      if (start.x === end.x && start.y === end.y) {
        throw new Error("A line annotation needs two different points.");
      }
      return { ...base, start, end };
    }
    case "shape": {
      const fillOpacity = base.fillOpacity === undefined
        ? undefined
        : clamp(requireFinite(base.fillOpacity, "Annotation fill opacity"));
      return {
        ...base,
        rect: normalizeRectToPage(base.rect),
        ...(fillOpacity === undefined ? {} : { fillOpacity }),
      };
    }
  }
}

export function cloneAnnotation(annotation: Annotation): Annotation {
  switch (annotation.kind) {
    case "ink":
      return {
        ...annotation,
        strokes: annotation.strokes.map((stroke) => stroke.map((point) => ({ ...point }))),
      };
    case "highlight":
      return { ...annotation, points: annotation.points.map((point) => ({ ...point })) };
    case "text":
    case "mark":
    case "shape":
      return { ...annotation, rect: { ...annotation.rect } };
    case "line":
      return { ...annotation, start: { ...annotation.start }, end: { ...annotation.end } };
  }
}

export function cloneAnnotationDocument(document: AnnotationDocument): AnnotationDocument {
  return {
    version: 1,
    pages: Object.fromEntries(
      Object.entries(document.pages).map(([pageId, annotations]) => [
        pageId,
        annotations.map(cloneAnnotation),
      ]),
    ),
  };
}

export function createAnnotationDocument(
  pageIds: readonly AnnotationPageId[] = [],
): AnnotationDocument {
  return {
    version: 1,
    pages: Object.fromEntries(pageIds.map((pageId) => [pageId, []])),
  };
}

export function getPageAnnotations(
  document: AnnotationDocument,
  pageId: AnnotationPageId,
): readonly Annotation[] {
  return document.pages[pageId] ?? [];
}

export function findAnnotation(
  document: AnnotationDocument,
  annotationId: AnnotationId,
): Annotation | undefined {
  for (const annotations of Object.values(document.pages)) {
    const found = annotations.find(({ id }) => id === annotationId);
    if (found) return found;
  }
  return undefined;
}

function hasAnnotationId(document: AnnotationDocument, annotationId: AnnotationId): boolean {
  return findAnnotation(document, annotationId) !== undefined;
}

function replacePage(
  document: AnnotationDocument,
  pageId: AnnotationPageId,
  annotations: Annotation[],
): AnnotationDocument {
  return { ...document, pages: { ...document.pages, [pageId]: annotations } };
}

export function addAnnotation(
  document: AnnotationDocument,
  annotation: Annotation,
): AnnotationDocument {
  const normalized = normalizeAnnotation(annotation);
  if (hasAnnotationId(document, normalized.id)) {
    throw new Error(`Annotation ID already exists: ${normalized.id}`);
  }
  return replacePage(document, normalized.pageId, [
    ...getPageAnnotations(document, normalized.pageId),
    normalized,
  ]);
}

export function updateAnnotation(
  document: AnnotationDocument,
  annotationId: AnnotationId,
  updater: AnnotationUpdater,
): AnnotationDocument {
  const existing = findAnnotation(document, annotationId);
  if (!existing) return document;
  const updated = normalizeAnnotation(updater(cloneAnnotation(existing)));
  if (updated.id !== existing.id || updated.pageId !== existing.pageId) {
    throw new Error("Updating an annotation cannot change its ID or page ID.");
  }
  return replacePage(
    document,
    existing.pageId,
    document.pages[existing.pageId].map((annotation) =>
      annotation.id === annotationId ? updated : annotation
    ),
  );
}

export function deleteAnnotations(
  document: AnnotationDocument,
  annotationIds: Iterable<AnnotationId>,
): AnnotationDocument {
  const removed = new Set(annotationIds);
  if (!removed.size) return document;
  let changed = false;
  const pages = Object.fromEntries(
    Object.entries(document.pages).map(([pageId, annotations]) => {
      const kept = annotations.filter(({ id }) => !removed.has(id));
      if (kept.length !== annotations.length) changed = true;
      return [pageId, kept];
    }),
  );
  return changed ? { ...document, pages } : document;
}

export function clearPageAnnotations(
  document: AnnotationDocument,
  pageId: AnnotationPageId,
): AnnotationDocument {
  if (!document.pages[pageId]?.length) return document;
  return replacePage(document, pageId, []);
}

/** Remove a page and every annotation associated with that page occurrence. */
export function removeAnnotationPage(
  document: AnnotationDocument,
  pageId: AnnotationPageId,
): AnnotationDocument {
  if (!(pageId in document.pages)) return document;
  const pages = { ...document.pages };
  delete pages[pageId];
  return { ...document, pages };
}

/**
 * Return annotations in a current organizer order. Reordering itself needs no
 * mutation because every annotation follows a stable page ID.
 */
export function annotationsForPageOrder(
  document: AnnotationDocument,
  pageIds: readonly AnnotationPageId[],
): Annotation[][] {
  return pageIds.map((pageId) => getPageAnnotations(document, pageId).map(cloneAnnotation));
}

export function duplicateAnnotations(
  document: AnnotationDocument,
  pageId: AnnotationPageId,
  annotationIds: Iterable<AnnotationId>,
  createId: AnnotationIdFactory,
  offset: AnnotationPoint = { x: 0.02, y: -0.02 },
): AnnotationDocument {
  const selected = new Set(annotationIds);
  const source = getPageAnnotations(document, pageId).filter(({ id }) => selected.has(id));
  if (!source.length) return document;
  const used = new Set(Object.values(document.pages).flat().map(({ id }) => id));
  const duplicates = source.map((annotation, index) => {
    const id = createId(annotation, index);
    if (!id.trim() || used.has(id)) throw new Error(`Duplicate annotation ID: ${id}`);
    used.add(id);
    return normalizeAnnotation({
      ...moveAnnotation(cloneAnnotation(annotation), offset),
      id,
      pageId,
    });
  });
  return replacePage(document, pageId, [...getPageAnnotations(document, pageId), ...duplicates]);
}

/** Deep-copy annotations when the organizer duplicates a page occurrence. */
export function duplicatePageAnnotations(
  document: AnnotationDocument,
  sourcePageId: AnnotationPageId,
  targetPageId: AnnotationPageId,
  createId: AnnotationIdFactory,
): AnnotationDocument {
  if (!targetPageId.trim()) throw new Error("Target page ID cannot be empty.");
  if (sourcePageId === targetPageId) throw new Error("A duplicated page needs a new page ID.");
  if (document.pages[targetPageId]?.length) {
    throw new Error(`Target page already has annotations: ${targetPageId}`);
  }
  const used = new Set(Object.values(document.pages).flat().map(({ id }) => id));
  const duplicates = getPageAnnotations(document, sourcePageId).map((annotation, index) => {
    const id = createId(annotation, index);
    if (!id.trim() || used.has(id)) throw new Error(`Duplicate annotation ID: ${id}`);
    used.add(id);
    return normalizeAnnotation({ ...cloneAnnotation(annotation), id, pageId: targetPageId });
  });
  return replacePage(document, targetPageId, duplicates);
}

/**
 * Whole-object eraser: touching an item removes the topmost hit by default.
 * `all: true` removes every overlapping item. This is lossless under undo.
 */
export function eraseAtViewportPoint(
  document: AnnotationDocument,
  pageId: AnnotationPageId,
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
  options: AnnotationHitTestOptions = {},
): EraseResult {
  const hits = hitTestAnnotations(getPageAnnotations(document, pageId), point, transform, options);
  const erasedIds = hits.map(({ id }) => id);
  return {
    document: erasedIds.length ? deleteAnnotations(document, erasedIds) : document,
    erasedIds,
  };
}
