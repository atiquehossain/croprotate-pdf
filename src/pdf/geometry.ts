import type {
  AspectPreset,
  CropUnit,
  PageInfo,
  Rotation,
  SourceCrop,
  VisualRect,
} from "../types";

export const FULL_VISUAL_RECT: VisualRect = [0, 0, 1, 1];
const EPSILON = 1e-7;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(Math.max(value, minimum), maximum);
}
export function normalizeRotation(value: number): Rotation {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return normalized as Rotation;
}

export function totalRotation(page: PageInfo, editRotation: Rotation): Rotation {
  return normalizeRotation(page.originalRotation + editRotation);
}

export function validateCrop(crop: SourceCrop): SourceCrop {
  if (crop === null) return null;
  let [left, bottom, right, top] = crop;
  left = clamp(left);
  bottom = clamp(bottom);
  right = clamp(right);
  top = clamp(top);
  if (left >= right || bottom >= top) {
    throw new Error("Crop coordinates must form a positive rectangle inside the page.");
  }
  if (
    Math.abs(left) < EPSILON &&
    Math.abs(bottom) < EPSILON &&
    Math.abs(right - 1) < EPSILON &&
    Math.abs(top - 1) < EPSILON
  ) {
    return null;
  }
  return [left, bottom, right, top];
}

export function visualToSource(
  x: number,
  y: number,
  rotation: Rotation,
): [number, number] {
  switch (rotation) {
    case 0:
      return [x, 1 - y];
    case 90:
      return [y, x];
    case 180:
      return [1 - x, y];
    case 270:
      return [1 - y, 1 - x];
  }
}

export function sourceToVisual(
  x: number,
  y: number,
  rotation: Rotation,
): [number, number] {
  switch (rotation) {
    case 0:
      return [x, 1 - y];
    case 90:
      return [y, x];
    case 180:
      return [1 - x, y];
    case 270:
      return [1 - y, 1 - x];
  }
}

export function visualRectToSourceCrop(
  rect: VisualRect,
  rotation: Rotation,
): SourceCrop {
  let [x0, y0, x1, y1] = rect.map((value) => clamp(value)) as VisualRect;
  [x0, x1] = x0 <= x1 ? [x0, x1] : [x1, x0];
  [y0, y1] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const corners = [
    visualToSource(x0, y0, rotation),
    visualToSource(x1, y0, rotation),
    visualToSource(x0, y1, rotation),
    visualToSource(x1, y1, rotation),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return validateCrop([
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ]);
}

export function sourceCropToVisualRect(
  crop: SourceCrop,
  rotation: Rotation,
): VisualRect {
  const valid = validateCrop(crop);
  if (valid === null) return [...FULL_VISUAL_RECT];
  const [left, bottom, right, top] = valid;
  const corners = [
    sourceToVisual(left, bottom, rotation),
    sourceToVisual(right, bottom, rotation),
    sourceToVisual(left, top, rotation),
    sourceToVisual(right, top, rotation),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function visualPageDimensions(
  page: PageInfo,
  rotation: Rotation,
): [number, number] {
  return rotation === 90 || rotation === 270
    ? [page.sourceHeightPoints, page.sourceWidthPoints]
    : [page.sourceWidthPoints, page.sourceHeightPoints];
}

export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function visualRectToPointMargins(
  rect: VisualRect,
  pageWidth: number,
  pageHeight: number,
): Margins {
  return {
    left: rect[0] * pageWidth,
    top: rect[1] * pageHeight,
    right: (1 - rect[2]) * pageWidth,
    bottom: (1 - rect[3]) * pageHeight,
  };
}

export function pointMarginsToVisualRect(
  margins: Margins,
  pageWidth: number,
  pageHeight: number,
): VisualRect {
  return [
    margins.left / pageWidth,
    margins.top / pageHeight,
    1 - margins.right / pageWidth,
    1 - margins.bottom / pageHeight,
  ];
}

export function pointsToUnit(points: number, unit: Exclude<CropUnit, "%">): number {
  if (unit === "pt") return points;
  if (unit === "in") return points / 72;
  return (points * 25.4) / 72;
}

export function unitToPoints(value: number, unit: Exclude<CropUnit, "%">): number {
  if (unit === "pt") return value;
  if (unit === "in") return value * 72;
  return (value * 72) / 25.4;
}

export function aspectRatioForPreset(
  preset: AspectPreset,
  pageWidth: number,
  pageHeight: number,
): number | null {
  switch (preset) {
    case "Free":
      return null;
    case "Original":
      return pageWidth / pageHeight;
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "3:4":
      return 3 / 4;
    case "16:9":
      return 16 / 9;
    case "9:16":
      return 9 / 16;
    case "A4 portrait":
      return 210 / 297;
    case "A4 landscape":
      return 297 / 210;
  }
}

export function normalizedAspectRatio(
  physicalRatio: number,
  pageWidth: number,
  pageHeight: number,
): number {
  return physicalRatio * (pageHeight / pageWidth);
}

export function fitRectToAspect(rect: VisualRect, normalizedRatio: number): VisualRect {
  const centerX = (rect[0] + rect[2]) / 2;
  const centerY = (rect[1] + rect[3]) / 2;
  let width = rect[2] - rect[0];
  let height = rect[3] - rect[1];
  if (width / height > normalizedRatio) {
    width = height * normalizedRatio;
  } else {
    height = width / normalizedRatio;
  }
  return [
    centerX - width / 2,
    centerY - height / 2,
    centerX + width / 2,
    centerY + height / 2,
  ];
}

export function parsePageSelection(specification: string, pageCount: number): number[] {
  const value = specification.trim().toLowerCase();
  if (!value || value === "all" || value === "*") {
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  if (value === "odd") {
    return Array.from({ length: pageCount }, (_, index) => index).filter(
      (index) => index % 2 === 0,
    );
  }
  if (value === "even") {
    return Array.from({ length: pageCount }, (_, index) => index).filter(
      (index) => index % 2 === 1,
    );
  }

  const selected = new Set<number>();
  for (const rawItem of value.replaceAll(" ", "").split(",")) {
    if (!rawItem) throw new Error("Remove empty items from the page list.");
    if (rawItem.includes("-")) {
      const pieces = rawItem.split("-");
      if (pieces.length !== 2 || pieces.some((piece) => !/^\d+$/.test(piece))) {
        throw new Error(`Invalid page range: ${rawItem}`);
      }
      const start = Number(pieces[0]);
      const end = Number(pieces[1]);
      if (start > end) throw new Error(`Range must go from low to high: ${rawItem}`);
      for (let page = start; page <= end; page += 1) {
        if (page < 1 || page > pageCount) {
          throw new Error(`Page ${page} is outside this PDF (1-${pageCount}).`);
        }
        selected.add(page - 1);
      }
    } else {
      if (!/^\d+$/.test(rawItem)) throw new Error(`Invalid page number: ${rawItem}`);
      const page = Number(rawItem);
      if (page < 1 || page > pageCount) {
        throw new Error(`Page ${page} is outside this PDF (1-${pageCount}).`);
      }
      selected.add(page - 1);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

export function cropsEqual(first: SourceCrop, second: SourceCrop): boolean {
  if (first === null || second === null) return first === second;
  return first.every((value, index) => Math.abs(value - second[index]) < 1e-9);
}
