import { describe, expect, it } from "vitest";
import type { Rotation } from "../types";
import {
  annotationBounds,
  hitTestAnnotation,
  hitTestAnnotations,
  moveAnnotation,
  moveAnnotationInViewport,
  pixelsToSourcePoint,
  resizeAnnotation,
  resizeAnnotationInViewport,
  sourcePointToPixels,
  sourcePointToViewport,
  viewportAnnotationBounds,
  viewportPointToSource,
  type AnnotationViewportTransform,
} from "./geometry";
import type { Annotation, InkAnnotation, TextAnnotation } from "./types";

const transform: AnnotationViewportTransform = {
  rotation: 0,
  crop: null,
  width: 300,
  height: 400,
  zoom: 1,
  sourceWidthPoints: 600,
  sourceHeightPoints: 800,
};

const base = {
  pageId: "page-a",
  color: "#111111",
  opacity: 1,
  width: 2,
};

describe("annotation viewport geometry", () => {
  it.each<Rotation>([0, 90, 180, 270])(
    "round-trips points through crop at %s degrees",
    (rotation) => {
      const view: AnnotationViewportTransform = {
        ...transform,
        rotation,
        crop: [0.1, 0.2, 0.9, 0.8],
      };
      const source = { x: 0.34, y: 0.61, pressure: 0.72 };
      const visual = sourcePointToViewport(source, view);
      const result = viewportPointToSource(visual, view);
      expect(result.x).toBeCloseTo(source.x, 9);
      expect(result.y).toBeCloseTo(source.y, 9);
      expect(result.pressure).toBe(source.pressure);
    },
  );

  it("round-trips zoomed pixel coordinates", () => {
    const source = { x: 0.25, y: 0.75 };
    const pixels = sourcePointToPixels(source, { ...transform, zoom: 2 });
    expect(pixels).toMatchObject({ x: 150, y: 200 });
    expect(pixelsToSourcePoint(pixels, { ...transform, zoom: 2 })).toEqual(source);
  });

  it("rejects non-positive pixel dimensions", () => {
    expect(() => sourcePointToPixels({ x: 0, y: 0 }, { ...transform, width: 0 })).toThrow(
      /positive/,
    );
  });
});

describe("annotation bounds and transforms", () => {
  const ink: InkAnnotation = {
    ...base,
    id: "ink",
    kind: "ink",
    tool: "pen",
    strokes: [[{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 }]],
  };

  it("computes source and cropped/rotated viewport bounds", () => {
    const sourceBounds = annotationBounds(ink);
    expect(sourceBounds.x).toBeCloseTo(0.1, 9);
    expect(sourceBounds.y).toBeCloseTo(0.2, 9);
    expect(sourceBounds.width).toBeCloseTo(0.3, 9);
    expect(sourceBounds.height).toBeCloseTo(0.4, 9);
    const bounds = viewportAnnotationBounds(ink, {
      ...transform,
      rotation: 90,
      crop: [0.1, 0.2, 0.9, 0.8],
    });
    expect(bounds.x).toBeCloseTo(0, 9);
    expect(bounds.y).toBeCloseTo(0, 9);
    expect(bounds.width).toBeCloseTo(2 / 3, 9);
    expect(bounds.height).toBeCloseTo(0.375, 9);
  });

  it("moves and clamps an annotation without mutating it", () => {
    const moved = moveAnnotation(ink, { x: 0.8, y: -0.5 }) as InkAnnotation;
    expect(moved.strokes[0][0].x).toBeCloseTo(0.7, 9);
    expect(moved.strokes[0][0].y).toBeCloseTo(0, 9);
    expect(moved.strokes[0][1].x).toBeCloseTo(1, 9);
    expect(moved.strokes[0][1].y).toBeCloseTo(0.4, 9);
    expect(ink.strokes[0][0]).toEqual({ x: 0.1, y: 0.2 });
  });

  it("moves by viewport delta through rotation and crop", () => {
    const view: AnnotationViewportTransform = {
      ...transform,
      rotation: 270,
      crop: [0.1, 0.1, 0.9, 0.9],
    };
    const before = sourcePointToViewport(ink.strokes[0][0], view);
    const moved = moveAnnotationInViewport(ink, { x: 0.08, y: -0.06 }, view, false) as InkAnnotation;
    const after = sourcePointToViewport(moved.strokes[0][0], view);
    expect(after.x - before.x).toBeCloseTo(0.08, 9);
    expect(after.y - before.y).toBeCloseTo(-0.06, 9);
  });

  it("resizes text and scales its point-sized font", () => {
    const text: TextAnnotation = {
      ...base,
      id: "text",
      kind: "text",
      tool: "text",
      rect: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
      text: "Hello",
      fontSize: 12,
    };
    const resized = resizeAnnotation(text, { x: 0.1, y: 0.2, width: 0.6, height: 0.2 });
    expect(resized.kind).toBe("text");
    if (resized.kind !== "text") throw new Error("Expected text annotation");
    expect(resized.rect.x).toBeCloseTo(0.1, 9);
    expect(resized.rect.y).toBeCloseTo(0.2, 9);
    expect(resized.rect.width).toBeCloseTo(0.6, 9);
    expect(resized.rect.height).toBeCloseTo(0.2, 9);
    expect(resized.fontSize).toBeCloseTo(24, 9);
    expect(resized.width).toBe(2);
  });

  it("resizes in the visual coordinate system", () => {
    const resized = resizeAnnotationInViewport(
      ink,
      { x: 0.2, y: 0.15, width: 0.5, height: 0.25 },
      { ...transform, rotation: 90 },
    );
    const bounds = viewportAnnotationBounds(resized, { ...transform, rotation: 90 });
    expect(bounds.x).toBeCloseTo(0.2, 9);
    expect(bounds.y).toBeCloseTo(0.15, 9);
    expect(bounds.width).toBeCloseTo(0.5, 9);
    expect(bounds.height).toBeCloseTo(0.25, 9);
  });
});

describe("annotation hit testing", () => {
  const cases: Array<[string, Annotation, { x: number; y: number }]> = [
    ["pen", { ...base, id: "pen", kind: "ink", tool: "pen", strokes: [[{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]] }, { x: 0.5, y: 0.5 }],
    ["signature", { ...base, id: "signature", kind: "ink", tool: "signature", strokes: [[{ x: 0.2, y: 0.5 }], [{ x: 0.2, y: 0.7 }, { x: 0.7, y: 0.5 }]] }, { x: 0.4, y: 0.38 }],
    ["highlighter", { ...base, id: "highlight", kind: "highlight", tool: "highlighter", points: [{ x: 0.1, y: 0.4 }, { x: 0.9, y: 0.4 }] }, { x: 0.5, y: 0.6 }],
    ["text", { ...base, id: "text", kind: "text", tool: "date", rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, text: "2026-10-01", fontSize: 12 }, { x: 0.3, y: 0.7 }],
    ["check", { ...base, id: "check", kind: "mark", tool: "check", rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }, { x: 0.28, y: 0.764 }],
    ["cross", { ...base, id: "cross", kind: "mark", tool: "cross", rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }, { x: 0.3, y: 0.7 }],
    ["arrow", { ...base, id: "arrow", kind: "line", tool: "arrow", start: { x: 0.1, y: 0.5 }, end: { x: 0.9, y: 0.5 } }, { x: 0.5, y: 0.5 }],
    ["rectangle", { ...base, id: "rect", kind: "shape", tool: "rectangle", rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }, { x: 0.2, y: 0.6 }],
    ["ellipse", { ...base, id: "ellipse", kind: "shape", tool: "ellipse", rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }, { x: 0.6, y: 0.6 }],
  ];

  it.each(cases)("hits a %s annotation", (_name, annotation, point) => {
    expect(hitTestAnnotation(annotation, point, transform, 0.005)).toBe(true);
    expect(hitTestAnnotation(annotation, { x: 0.98, y: 0.02 }, transform, 0.005)).toBe(false);
  });

  it("returns overlapping annotations topmost first", () => {
    const bottom = cases[0][1];
    const top: Annotation = {
      ...base,
      id: "top",
      kind: "line",
      tool: "line",
      start: { x: 0.1, y: 0.5 },
      end: { x: 0.9, y: 0.5 },
    };
    expect(hitTestAnnotations([bottom, top], { x: 0.5, y: 0.5 }, transform).map(({ id }) => id))
      .toEqual(["top"]);
    expect(hitTestAnnotations(
      [bottom, top],
      { x: 0.5, y: 0.5 },
      transform,
      { all: true },
    ).map(({ id }) => id)).toEqual(["top", "pen"]);
  });

  it("hits an arrowhead as well as its shaft", () => {
    const arrow: Annotation = {
      ...base,
      id: "arrowhead",
      kind: "line",
      tool: "arrow",
      start: { x: 0.2, y: 0.5 },
      end: { x: 0.8, y: 0.5 },
    };
    expect(hitTestAnnotation(arrow, { x: 0.776, y: 0.513 }, transform, 0.002)).toBe(true);
  });

  it("uses physical point width for zoom-independent hit slop", () => {
    const thick: Annotation = {
      ...base,
      width: 24,
      id: "thick",
      kind: "line",
      tool: "line",
      start: { x: 0.1, y: 0.5 },
      end: { x: 0.9, y: 0.5 },
    };
    expect(hitTestAnnotation(thick, { x: 0.5, y: 0.51 }, transform, 0)).toBe(true);
    expect(hitTestAnnotation(thick, { x: 0.5, y: 0.53 }, transform, 0)).toBe(false);
  });
});
