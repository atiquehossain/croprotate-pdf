import {
  sourceCropToVisualRect,
  sourceToVisual,
  visualToSource,
} from "../pdf/geometry";
import type { Rotation, SourceCrop } from "../types";
import type {
  Annotation,
  AnnotationPoint,
  AnnotationRect,
} from "./types";

const EPSILON = 1e-9;

/** The visible PDF viewport before its CSS/layout transform is applied. */
export interface AnnotationViewportTransform {
  rotation: Rotation;
  crop: SourceCrop;
  /** Unzoomed viewport width in CSS pixels. Required only by pixel helpers. */
  width?: number;
  /** Unzoomed viewport height in CSS pixels. Required only by pixel helpers. */
  height?: number;
  zoom?: number;
  /** Physical source dimensions make point-based stroke hit testing exact. */
  sourceWidthPoints?: number;
  sourceHeightPoints?: number;
}

export interface AnnotationHitTestOptions {
  /** Extra hit slop in normalized visible-viewport coordinates. */
  tolerance?: number;
  /** Return every hit in topmost-first order instead of just the top item. */
  all?: boolean;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeAnnotationRect(rect: AnnotationRect): AnnotationRect {
  let x = finite(rect.x);
  let y = finite(rect.y);
  let width = finite(rect.width);
  let height = finite(rect.height);
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

function viewportCrop(transform: AnnotationViewportTransform): AnnotationRect {
  const [left, top, right, bottom] = sourceCropToVisualRect(
    transform.crop,
    transform.rotation,
  );
  return {
    x: left,
    y: top,
    width: Math.max(right - left, EPSILON),
    height: Math.max(bottom - top, EPSILON),
  };
}

/** Convert a source PDF point to normalized visible-viewport coordinates. */
export function sourcePointToViewport(
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
): AnnotationPoint {
  const [visualX, visualY] = sourceToVisual(point.x, point.y, transform.rotation);
  const crop = viewportCrop(transform);
  return {
    x: (visualX - crop.x) / crop.width,
    y: (visualY - crop.y) / crop.height,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  };
}

/** Convert a normalized visible-viewport point back to source PDF coordinates. */
export function viewportPointToSource(
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
): AnnotationPoint {
  const crop = viewportCrop(transform);
  const visualX = crop.x + point.x * crop.width;
  const visualY = crop.y + point.y * crop.height;
  const [sourceX, sourceY] = visualToSource(visualX, visualY, transform.rotation);
  return {
    x: sourceX,
    y: sourceY,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  };
}

function pixelSize(transform: AnnotationViewportTransform): [number, number] {
  const zoom = transform.zoom ?? 1;
  const width = (transform.width ?? 1) * zoom;
  const height = (transform.height ?? 1) * zoom;
  if (!(width > 0) || !(height > 0)) {
    throw new Error("Annotation viewport pixel dimensions must be positive.");
  }
  return [width, height];
}

export function sourcePointToPixels(
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
): AnnotationPoint {
  const viewport = sourcePointToViewport(point, transform);
  const [width, height] = pixelSize(transform);
  return { ...viewport, x: viewport.x * width, y: viewport.y * height };
}

export function pixelsToSourcePoint(
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
): AnnotationPoint {
  const [width, height] = pixelSize(transform);
  return viewportPointToSource(
    { ...point, x: point.x / width, y: point.y / height },
    transform,
  );
}

function rectCorners(rect: AnnotationRect): AnnotationPoint[] {
  const normalized = normalizeAnnotationRect(rect);
  return [
    { x: normalized.x, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y + normalized.height },
    { x: normalized.x, y: normalized.y + normalized.height },
  ];
}

function geometryPoints(annotation: Annotation): AnnotationPoint[] {
  switch (annotation.kind) {
    case "ink":
      return annotation.strokes.flat();
    case "highlight":
      return annotation.points;
    case "text":
    case "mark":
    case "shape":
      return rectCorners(annotation.rect);
    case "line":
      return [annotation.start, annotation.end];
  }
}

function boundsFromPoints(points: readonly AnnotationPoint[]): AnnotationRect {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

/** Geometry bounds in source coordinates, excluding stroke-width padding. */
export function annotationBounds(annotation: Annotation): AnnotationRect {
  if (annotation.kind === "text" || annotation.kind === "mark" || annotation.kind === "shape") {
    return normalizeAnnotationRect(annotation.rect);
  }
  return boundsFromPoints(geometryPoints(annotation));
}

/** Selection bounds in normalized, cropped and rotated viewport coordinates. */
export function viewportAnnotationBounds(
  annotation: Annotation,
  transform: AnnotationViewportTransform,
): AnnotationRect {
  return boundsFromPoints(
    geometryPoints(annotation).map((point) => sourcePointToViewport(point, transform)),
  );
}

function distance(first: AnnotationPoint, second: AnnotationPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function distanceToSegment(
  point: AnnotationPoint,
  start: AnnotationPoint,
  end: AnnotationPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return distance(point, start);
  const projection = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  );
  return distance(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  });
}

function distanceToPath(point: AnnotationPoint, path: readonly AnnotationPoint[]): number {
  if (!path.length) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return distance(point, path[0]);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegment(point, path[index - 1], path[index]));
  }
  return nearest;
}

function containsPoint(rect: AnnotationRect, point: AnnotationPoint, padding = 0): boolean {
  const normalized = normalizeAnnotationRect(rect);
  return point.x >= normalized.x - padding &&
    point.x <= normalized.x + normalized.width + padding &&
    point.y >= normalized.y - padding &&
    point.y <= normalized.y + normalized.height + padding;
}

function rectBorderDistance(rect: AnnotationRect, point: AnnotationPoint): number {
  const normalized = normalizeAnnotationRect(rect);
  if (!containsPoint(normalized, point)) {
    const clamped = {
      x: clamp(point.x, normalized.x, normalized.x + normalized.width),
      y: clamp(point.y, normalized.y, normalized.y + normalized.height),
    };
    return distance(point, clamped);
  }
  return Math.min(
    point.x - normalized.x,
    normalized.x + normalized.width - point.x,
    point.y - normalized.y,
    normalized.y + normalized.height - point.y,
  );
}

function mappedRect(
  rect: AnnotationRect,
  transform: AnnotationViewportTransform,
): AnnotationRect {
  return boundsFromPoints(
    rectCorners(rect).map((point) => sourcePointToViewport(point, transform)),
  );
}

function strokeRadiusInViewport(
  widthPoints: number,
  transform: AnnotationViewportTransform,
): number {
  const pageWidth = transform.sourceWidthPoints;
  const pageHeight = transform.sourceHeightPoints;
  if (!(pageWidth && pageWidth > 0 && pageHeight && pageHeight > 0)) return 0;
  const center = { x: 0.5, y: 0.5 };
  const radius = Math.max(0, widthPoints) / 2;
  const mappedCenter = sourcePointToViewport(center, transform);
  const mappedX = sourcePointToViewport({ x: center.x + radius / pageWidth, y: center.y }, transform);
  const mappedY = sourcePointToViewport({ x: center.x, y: center.y + radius / pageHeight }, transform);
  return Math.max(distance(mappedCenter, mappedX), distance(mappedCenter, mappedY));
}

/** Hit-test one annotation using a point and tolerance in visible-viewport units. */
export function hitTestAnnotation(
  annotation: Annotation,
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
  tolerance = 0.012,
): boolean {
  const slop = Math.max(0, tolerance) + strokeRadiusInViewport(annotation.width, transform);
  switch (annotation.kind) {
    case "ink": {
      const paths = annotation.strokes.map((stroke) =>
        stroke.map((item) => sourcePointToViewport(item, transform))
      );
      return paths.some((path) => distanceToPath(point, path) <= slop);
    }
    case "highlight": {
      const path = annotation.points.map((item) => sourcePointToViewport(item, transform));
      return distanceToPath(point, path) <= slop;
    }
    case "text":
      return containsPoint(mappedRect(annotation.rect, transform), point, slop);
    case "line":
      if (distanceToSegment(
        point,
        sourcePointToViewport(annotation.start, transform),
        sourcePointToViewport(annotation.end, transform),
      ) <= slop) return true;
      if (annotation.tool !== "arrow") return false;
      {
        const start = sourcePointToViewport(annotation.start, transform);
        const end = sourcePointToViewport(annotation.end, transform);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length < EPSILON) return false;
        const headLength = Math.min(length * 0.45, Math.max(0.025, slop * 4));
        const ux = dx / length;
        const uy = dy / length;
        const backX = end.x - ux * headLength;
        const backY = end.y - uy * headLength;
        const wing = headLength * 0.55;
        const first = { x: backX - uy * wing, y: backY + ux * wing };
        const second = { x: backX + uy * wing, y: backY - ux * wing };
        return distanceToSegment(point, end, first) <= slop ||
          distanceToSegment(point, end, second) <= slop;
      }
    case "mark": {
      const rect = mappedRect(annotation.rect, transform);
      const p = (x: number, y: number): AnnotationPoint => ({
        x: rect.x + rect.width * x,
        y: rect.y + rect.height * y,
      });
      const segments = annotation.tool === "check"
        ? [[p(0.12, 0.52), p(0.4, 0.82)], [p(0.4, 0.82), p(0.9, 0.14)]]
        : [[p(0.12, 0.12), p(0.88, 0.88)], [p(0.88, 0.12), p(0.12, 0.88)]];
      return segments.some(([start, end]) => distanceToSegment(point, start, end) <= slop);
    }
    case "shape": {
      const rect = mappedRect(annotation.rect, transform);
      if (annotation.fillColor && (annotation.fillOpacity ?? 0) > 0 && containsPoint(rect, point)) {
        if (annotation.tool === "rectangle") return true;
        const rx = Math.max(rect.width / 2, EPSILON);
        const ry = Math.max(rect.height / 2, EPSILON);
        const nx = (point.x - (rect.x + rx)) / rx;
        const ny = (point.y - (rect.y + ry)) / ry;
        return nx * nx + ny * ny <= 1;
      }
      if (annotation.tool === "rectangle") return rectBorderDistance(rect, point) <= slop;
      const rx = Math.max(rect.width / 2, EPSILON);
      const ry = Math.max(rect.height / 2, EPSILON);
      const nx = (point.x - (rect.x + rx)) / rx;
      const ny = (point.y - (rect.y + ry)) / ry;
      return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) <= slop;
    }
  }
}

/** Find hits in paint order, topmost first. */
export function hitTestAnnotations(
  annotations: readonly Annotation[],
  point: AnnotationPoint,
  transform: AnnotationViewportTransform,
  options: AnnotationHitTestOptions = {},
): Annotation[] {
  const hits: Annotation[] = [];
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (hitTestAnnotation(annotation, point, transform, options.tolerance)) {
      hits.push(annotation);
      if (!options.all) break;
    }
  }
  return hits;
}

function mapRect(
  rect: AnnotationRect,
  mapper: (point: AnnotationPoint) => AnnotationPoint,
): AnnotationRect {
  return boundsFromPoints(rectCorners(rect).map(mapper));
}

function mapAnnotation(
  annotation: Annotation,
  mapper: (point: AnnotationPoint) => AnnotationPoint,
  fontScale = 1,
): Annotation {
  switch (annotation.kind) {
    case "ink":
      return { ...annotation, strokes: annotation.strokes.map((stroke) => stroke.map(mapper)) };
    case "highlight":
      return { ...annotation, points: annotation.points.map(mapper) };
    case "text":
      return {
        ...annotation,
        rect: mapRect(annotation.rect, mapper),
        fontSize: Math.max(EPSILON, annotation.fontSize * Math.abs(fontScale)),
      };
    case "mark":
    case "shape":
      return { ...annotation, rect: mapRect(annotation.rect, mapper) };
    case "line":
      return { ...annotation, start: mapper(annotation.start), end: mapper(annotation.end) };
  }
}

function clampDelta(bounds: AnnotationRect, delta: AnnotationPoint): AnnotationPoint {
  const maxX = 1 - (bounds.x + bounds.width);
  const maxY = 1 - (bounds.y + bounds.height);
  return {
    x: bounds.width > 1 ? 0 : clamp(delta.x, -bounds.x, maxX),
    y: bounds.height > 1 ? 0 : clamp(delta.y, -bounds.y, maxY),
  };
}

/** Move an annotation by a source-normalized delta. */
export function moveAnnotation(
  annotation: Annotation,
  delta: AnnotationPoint,
  keepInsidePage = true,
): Annotation {
  const applied = keepInsidePage
    ? clampDelta(annotationBounds(annotation), delta)
    : delta;
  return mapAnnotation(annotation, (point) => ({
    ...point,
    x: point.x + applied.x,
    y: point.y + applied.y,
  }));
}

/** Move using a top-left viewport delta, respecting crop and rotation. */
export function moveAnnotationInViewport(
  annotation: Annotation,
  delta: AnnotationPoint,
  transform: AnnotationViewportTransform,
  keepInsidePage = true,
): Annotation {
  const origin = viewportPointToSource({ x: 0, y: 0 }, transform);
  const target = viewportPointToSource({ x: delta.x, y: delta.y }, transform);
  return moveAnnotation(
    annotation,
    { x: target.x - origin.x, y: target.y - origin.y },
    keepInsidePage,
  );
}

function boundsMapper(
  source: AnnotationRect,
  target: AnnotationRect,
): (point: AnnotationPoint) => AnnotationPoint {
  const from = normalizeAnnotationRect(source);
  const to = normalizeAnnotationRect(target);
  return (point) => ({
    ...point,
    x: from.width < EPSILON
      ? to.x + to.width / 2
      : to.x + ((point.x - from.x) / from.width) * to.width,
    y: from.height < EPSILON
      ? to.y + to.height / 2
      : to.y + ((point.y - from.y) / from.height) * to.height,
  });
}

/** Resize an annotation to a source-coordinate selection rectangle. */
export function resizeAnnotation(
  annotation: Annotation,
  nextBounds: AnnotationRect,
): Annotation {
  const previous = annotationBounds(annotation);
  const next = normalizeAnnotationRect(nextBounds);
  const fontScale = previous.height > EPSILON ? next.height / previous.height : 1;
  return mapAnnotation(annotation, boundsMapper(previous, next), fontScale);
}

/** Resize an annotation using a visible-viewport selection rectangle. */
export function resizeAnnotationInViewport(
  annotation: Annotation,
  nextBounds: AnnotationRect,
  transform: AnnotationViewportTransform,
): Annotation {
  const previous = viewportAnnotationBounds(annotation, transform);
  const mapper = boundsMapper(previous, normalizeAnnotationRect(nextBounds));
  const fontScale = previous.height > EPSILON ? Math.abs(nextBounds.height / previous.height) : 1;
  return mapAnnotation(
    annotation,
    (point) => viewportPointToSource(mapper(sourcePointToViewport(point, transform)), transform),
    fontScale,
  );
}
