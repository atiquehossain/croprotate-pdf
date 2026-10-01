import * as mupdf from "mupdf";
import type {
  Annotation,
  AnnotationPoint,
  AnnotationRect,
  ShapeAnnotation,
  TextAnnotation,
} from "../annotations/types";
import type { PageInfo, PdfRect } from "../types";

const MAX_ANNOTATIONS_PER_PAGE = 5_000;
const MAX_ANNOTATIONS_PER_EXPORT = 25_000;
const MAX_POINTS_PER_STROKE = 50_000;
const MAX_POINTS_PER_EXPORT = 1_000_000;
const MAX_TEXT_LENGTH = 10_000;
const MIN_STROKE_POINTS = 0.25;
const MAX_STROKE_POINTS = 512;
const MAX_FONT_POINTS = 512;

export type PdfMatrix = [number, number, number, number, number, number];
export type PdfPoint = [number, number];

export interface ParsedCssColor {
  color: [number, number, number];
  alpha: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`An annotation contains an invalid ${label}.`);
  }
  return value;
}

function byteFromHex(value: string): number {
  return Number.parseInt(value, 16) / 255;
}

function parseRgbChannel(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent) ? clamp(percent / 100, 0, 1) : null;
  }
  const channel = Number.parseFloat(trimmed);
  return Number.isFinite(channel) ? clamp(channel / 255, 0, 1) : null;
}

function parseAlpha(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent) ? clamp(percent / 100, 0, 1) : null;
  }
  const alpha = Number.parseFloat(trimmed);
  return Number.isFinite(alpha) ? clamp(alpha, 0, 1) : null;
}

const NAMED_COLORS: Record<string, ParsedCssColor> = {
  black: { color: [0, 0, 0], alpha: 1 },
  blue: { color: [0, 0, 1], alpha: 1 },
  gray: { color: [128 / 255, 128 / 255, 128 / 255], alpha: 1 },
  green: { color: [0, 128 / 255, 0], alpha: 1 },
  orange: { color: [1, 165 / 255, 0], alpha: 1 },
  purple: { color: [128 / 255, 0, 128 / 255], alpha: 1 },
  red: { color: [1, 0, 0], alpha: 1 },
  transparent: { color: [0, 0, 0], alpha: 0 },
  white: { color: [1, 1, 1], alpha: 1 },
  yellow: { color: [1, 1, 0], alpha: 1 },
};

/**
 * Parse the CSS color forms emitted by the annotation controls without using a
 * DOM or canvas. Keeping this worker-safe also prevents annotation data from
 * ever leaving the local PDF worker.
 */
export function parseAnnotationColor(value: string): ParsedCssColor {
  const input = value.trim().toLowerCase();
  const named = NAMED_COLORS[input];
  if (named) return { color: [...named.color], alpha: named.alpha };

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return {
        color: [
          byteFromHex(hex[0] + hex[0]),
          byteFromHex(hex[1] + hex[1]),
          byteFromHex(hex[2] + hex[2]),
        ],
        alpha: hex.length === 4 ? byteFromHex(hex[3] + hex[3]) : 1,
      };
    }
    return {
      color: [byteFromHex(hex.slice(0, 2)), byteFromHex(hex.slice(2, 4)), byteFromHex(hex.slice(4, 6))],
      alpha: hex.length === 8 ? byteFromHex(hex.slice(6, 8)) : 1,
    };
  }

  const rgb = /^rgba?\((.+)\)$/i.exec(input)?.[1];
  if (rgb) {
    const parts = rgb.includes(",")
      ? rgb.split(",").map((part) => part.trim())
      : rgb.trim().split(/\s+(?:\/\s*)?/);
    if (parts.length === 3 || parts.length === 4) {
      const channels = parts.slice(0, 3).map(parseRgbChannel);
      const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1;
      if (channels.every((channel) => channel !== null) && alpha !== null) {
        return {
          color: channels as [number, number, number],
          alpha,
        };
      }
    }
  }

  throw new Error(`Unsupported annotation color: ${value || "(empty)"}.`);
}

function normalizePoint(point: AnnotationPoint): AnnotationPoint {
  return {
    x: clamp(finiteNumber(point.x, "horizontal coordinate"), 0, 1),
    y: clamp(finiteNumber(point.y, "vertical coordinate"), 0, 1),
    ...(point.pressure === undefined
      ? {}
      : { pressure: clamp(finiteNumber(point.pressure, "stylus pressure"), 0, 1) }),
  };
}

function normalizeRect(rect: AnnotationRect): AnnotationRect {
  const x1 = clamp(finiteNumber(rect.x, "rectangle coordinate"), 0, 1);
  const y1 = clamp(finiteNumber(rect.y, "rectangle coordinate"), 0, 1);
  const x2 = clamp(x1 + finiteNumber(rect.width, "rectangle width"), 0, 1);
  const y2 = clamp(y1 + finiteNumber(rect.height, "rectangle height"), 0, 1);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function transformPdfPoint(point: PdfPoint, matrix: PdfMatrix): PdfPoint {
  return [
    point[0] * matrix[0] + point[1] * matrix[2] + matrix[4],
    point[0] * matrix[1] + point[1] * matrix[3] + matrix[5],
  ];
}

/** Map source-normalized, bottom-left coordinates into MuPDF page space. */
export function sourcePointToPagePoint(
  point: AnnotationPoint,
  rawCropBox: PdfRect,
  pageTransform: PdfMatrix,
): PdfPoint {
  const normalized = normalizePoint(point);
  const [left, bottom, right, top] = rawCropBox;
  return transformPdfPoint(
    [
      left + normalized.x * (right - left),
      bottom + normalized.y * (top - bottom),
    ],
    pageTransform,
  );
}

/** Map a source-normalized rectangle through any 0/90/180/270 page rotation. */
export function sourceRectToPageRect(
  rect: AnnotationRect,
  rawCropBox: PdfRect,
  pageTransform: PdfMatrix,
): PdfRect {
  const normalized = normalizeRect(rect);
  const corners = [
    { x: normalized.x, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y },
    { x: normalized.x, y: normalized.y + normalized.height },
    { x: normalized.x + normalized.width, y: normalized.y + normalized.height },
  ].map((point) => sourcePointToPagePoint(point, rawCropBox, pageTransform));
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function effectiveOpacity(opacity: number, colorAlpha: number): number {
  return clamp(finiteNumber(opacity, "opacity"), 0, 1) * colorAlpha;
}

/** MuPDF annotation style values use default PDF user units, not page space. */
export function physicalPointsToPdfUnits(points: number, userUnit: number): number {
  const safePoints = finiteNumber(points, "physical size");
  const safeUserUnit = finiteNumber(userUnit, "page UserUnit");
  if (safeUserUnit <= 0) throw new Error("An annotation page has an invalid UserUnit.");
  return safePoints / safeUserUnit;
}

function strokeWidth(annotation: Annotation, info: PageInfo): number {
  return physicalPointsToPdfUnits(clamp(
    finiteNumber(annotation.width, "stroke width"),
    MIN_STROKE_POINTS,
    MAX_STROKE_POINTS,
  ), info.userUnit);
}

function configureAnnotation(
  annotation: mupdf.PDFAnnotation,
  colorValue: string,
  opacityValue: number,
  width?: number,
): void {
  const parsed = parseAnnotationColor(colorValue);
  annotation.setColor(parsed.color);
  annotation.setOpacity(effectiveOpacity(opacityValue, parsed.alpha));
  if (width !== undefined) annotation.setBorderWidth(width);
  annotation.setFlags(annotation.getFlags() | mupdf.PDFAnnotation.IS_PRINT);
}

function createMappedInk(
  page: mupdf.PDFPage,
  mappedStrokes: PdfPoint[][],
  info: PageInfo,
  annotation: Annotation,
): number {
  const mapped = mappedStrokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      if (stroke.length > MAX_POINTS_PER_STROKE) {
        throw new Error(`An annotation stroke exceeds the ${MAX_POINTS_PER_STROKE.toLocaleString()}-point safety limit.`);
      }
      return stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
    });
  if (!mapped.length) return 0;

  const ink = page.createAnnotation("Ink");
  try {
    ink.setInkList(mapped);
    configureAnnotation(ink, annotation.color, annotation.opacity, strokeWidth(annotation, info));
    ink.update();
  } finally {
    ink.destroy();
  }
  return 1;
}

function createInk(
  page: mupdf.PDFPage,
  strokes: AnnotationPoint[][],
  info: PageInfo,
  pageTransform: PdfMatrix,
  annotation: Annotation,
): number {
  return createMappedInk(
    page,
    strokes.map((stroke) => stroke.map((point) =>
      sourcePointToPagePoint(point, info.rawCropBox, pageTransform)
    )),
    info,
    annotation,
  );
}

function createText(
  page: mupdf.PDFPage,
  info: PageInfo,
  pageTransform: PdfMatrix,
  annotation: TextAnnotation,
): number {
  if (!annotation.text) return 0;
  if (annotation.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Annotation text exceeds the ${MAX_TEXT_LENGTH.toLocaleString()}-character safety limit.`);
  }
  const rect = sourceRectToPageRect(annotation.rect, info.rawCropBox, pageTransform);
  if (rect[0] === rect[2] || rect[1] === rect[3]) return 0;
  const parsed = parseAnnotationColor(annotation.color);
  const font = {
    "sans-serif": "Helvetica",
    serif: "Times-Roman",
    monospace: "Courier",
    cursive: "Helvetica-Oblique",
  }[annotation.fontFamily ?? "sans-serif"];
  const fontProbe = new mupdf.Font(font);
  try {
    for (const character of annotation.text) {
      if (/\s/u.test(character)) continue;
      if (fontProbe.encodeCharacter(character) === 0) {
        throw new Error(
          "Typed text contains characters the built-in PDF font cannot export. Use the pen or a drawn signature for this text.",
        );
      }
    }
  } finally {
    fontProbe.destroy();
  }
  const fontSize = physicalPointsToPdfUnits(clamp(
    finiteNumber(annotation.fontSize, "font size"),
    1,
    MAX_FONT_POINTS,
  ), info.userUnit);
  const freeText = page.createAnnotation("FreeText");
  try {
    freeText.setRect(rect);
    freeText.setContents(annotation.text);
    freeText.setDefaultAppearance(font, fontSize, parsed.color);
    freeText.setQuadding({ left: 0, center: 1, right: 2 }[annotation.align ?? "left"]);
    freeText.setBorderWidth(0);
    freeText.setOpacity(effectiveOpacity(annotation.opacity, parsed.alpha));
    freeText.setFlags(freeText.getFlags() | mupdf.PDFAnnotation.IS_PRINT);
    freeText.update();
  } finally {
    freeText.destroy();
  }
  return 1;
}

function createLine(
  page: mupdf.PDFPage,
  info: PageInfo,
  pageTransform: PdfMatrix,
  annotation: Extract<Annotation, { kind: "line" }>,
): number {
  const line = page.createAnnotation("Line");
  try {
    line.setLine(
      sourcePointToPagePoint(annotation.start, info.rawCropBox, pageTransform),
      sourcePointToPagePoint(annotation.end, info.rawCropBox, pageTransform),
    );
    if (annotation.tool === "arrow") {
      line.setIntent("LineArrow");
      line.setLineEndingStyles("None", "ClosedArrow");
    }
    configureAnnotation(line, annotation.color, annotation.opacity, strokeWidth(annotation, info));
    line.update();
  } finally {
    line.destroy();
  }
  return 1;
}

function createShapePart(
  page: mupdf.PDFPage,
  info: PageInfo,
  pageTransform: PdfMatrix,
  annotation: ShapeAnnotation,
  part: "fill" | "stroke",
): number {
  const shape = page.createAnnotation(annotation.tool === "ellipse" ? "Circle" : "Square");
  try {
    shape.setRect(sourceRectToPageRect(annotation.rect, info.rawCropBox, pageTransform));
    shape.setFlags(shape.getFlags() | mupdf.PDFAnnotation.IS_PRINT);
    if (part === "fill") {
      const parsed = parseAnnotationColor(annotation.fillColor ?? "transparent");
      shape.setColor([]);
      shape.setBorderWidth(0);
      shape.setInteriorColor(parsed.color);
      shape.setOpacity(effectiveOpacity(annotation.fillOpacity ?? 0, parsed.alpha));
    } else {
      configureAnnotation(shape, annotation.color, annotation.opacity, strokeWidth(annotation, info));
    }
    shape.update();
  } finally {
    shape.destroy();
  }
  return 1;
}

function createShape(
  page: mupdf.PDFPage,
  info: PageInfo,
  pageTransform: PdfMatrix,
  annotation: ShapeAnnotation,
): number {
  const rect = normalizeRect(annotation.rect);
  if (rect.width === 0 || rect.height === 0) return 0;
  let created = 0;
  if (annotation.fillColor && (annotation.fillOpacity ?? 0) > 0) {
    created += createShapePart(page, info, pageTransform, annotation, "fill");
  }
  if (annotation.opacity > 0 && annotation.width > 0) {
    created += createShapePart(page, info, pageTransform, annotation, "stroke");
  }
  return created;
}

/**
 * Build marks in final page/view space. The UI first maps a source rectangle to
 * an axis-aligned viewport rectangle and then draws an upright glyph inside
 * it; constructing the glyph in source space would rotate it with `/Rotate`.
 */
export function markStrokesToPage(
  annotation: Extract<Annotation, { kind: "mark" }>,
  rawCropBox: PdfRect,
  pageTransform: PdfMatrix,
): PdfPoint[][] {
  const rect = sourceRectToPageRect(annotation.rect, rawCropBox, pageTransform);
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];
  const at = (x: number, y: number): PdfPoint => [
    rect[0] + width * x,
    rect[1] + height * y,
  ];
  if (annotation.tool === "cross") {
    return [
      [at(0.13, 0.13), at(0.87, 0.87)],
      [at(0.87, 0.13), at(0.13, 0.87)],
    ];
  }
  return [[at(0.1, 0.52), at(0.39, 0.84), at(0.92, 0.12)]];
}

/**
 * Add local app annotations to a page using MuPDF's vector annotation API.
 * The caller may subsequently bake them to page content; every object has a
 * generated appearance and the PDF Print flag before this function returns.
 */
export function addAnnotationsToPage(
  page: mupdf.PDFPage,
  info: PageInfo,
  annotations: readonly Annotation[],
): number {
  if (annotations.length > MAX_ANNOTATIONS_PER_PAGE) {
    throw new Error(`A page exceeds the ${MAX_ANNOTATIONS_PER_PAGE.toLocaleString()}-annotation safety limit.`);
  }
  const pageTransform = page.getTransform() as PdfMatrix;
  let created = 0;
  for (const annotation of annotations) {
    switch (annotation.kind) {
      case "ink":
        created += createInk(page, annotation.strokes, info, pageTransform, annotation);
        break;
      case "highlight":
        created += createInk(page, [annotation.points], info, pageTransform, annotation);
        break;
      case "text":
        created += createText(page, info, pageTransform, annotation);
        break;
      case "mark":
        created += createMappedInk(
          page,
          markStrokesToPage(annotation, info.rawCropBox, pageTransform),
          info,
          annotation,
        );
        break;
      case "line":
        created += createLine(page, info, pageTransform, annotation);
        break;
      case "shape":
        created += createShape(page, info, pageTransform, annotation);
        break;
    }
  }
  if (created) page.update();
  return created;
}

/** Fast, allocation-free limits before MuPDF copies or mutates the document. */
export function validateAnnotationPages(
  pages: readonly (readonly Annotation[])[],
): void {
  let annotationCount = 0;
  let pointCount = 0;
  for (const annotations of pages) {
    if (annotations.length > MAX_ANNOTATIONS_PER_PAGE) {
      throw new Error(`A page exceeds the ${MAX_ANNOTATIONS_PER_PAGE.toLocaleString()}-annotation safety limit.`);
    }
    annotationCount += annotations.length;
    if (annotationCount > MAX_ANNOTATIONS_PER_EXPORT) {
      throw new Error(`This export exceeds the ${MAX_ANNOTATIONS_PER_EXPORT.toLocaleString()}-annotation safety limit.`);
    }
    for (const annotation of annotations) {
      const strokes = annotation.kind === "ink"
        ? annotation.strokes
        : annotation.kind === "highlight"
          ? [annotation.points]
          : [];
      for (const stroke of strokes) {
        if (stroke.length > MAX_POINTS_PER_STROKE) {
          throw new Error(`An annotation stroke exceeds the ${MAX_POINTS_PER_STROKE.toLocaleString()}-point safety limit.`);
        }
        pointCount += stroke.length;
        if (pointCount > MAX_POINTS_PER_EXPORT) {
          throw new Error(`This export exceeds the ${MAX_POINTS_PER_EXPORT.toLocaleString()}-point safety limit.`);
        }
      }
    }
  }
}
