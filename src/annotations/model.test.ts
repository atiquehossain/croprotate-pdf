import { describe, expect, it } from "vitest";
import type { Annotation, InkAnnotation } from "./types";
import {
  addAnnotation,
  annotationsForPageOrder,
  createAnnotationDocument,
  deleteAnnotations,
  duplicateAnnotations,
  duplicatePageAnnotations,
  eraseAtViewportPoint,
  findAnnotation,
  getPageAnnotations,
  normalizeAnnotation,
  removeAnnotationPage,
  updateAnnotation,
} from "./model";

const base = {
  color: "#111111",
  opacity: 1,
  width: 2,
};

function pen(id: string, pageId = "p1"): InkAnnotation {
  return {
    ...base,
    id,
    pageId,
    kind: "ink",
    tool: "pen",
    strokes: [[{ x: 0.1, y: 0.2, pressure: 0.4 }, { x: 0.4, y: 0.5 }]],
  };
}

describe("annotation document mutations", () => {
  it("adds and updates annotations immutably in paint order", () => {
    const empty = createAnnotationDocument(["p1"]);
    const first = addAnnotation(empty, pen("a"));
    const second = addAnnotation(first, {
      ...base,
      id: "b",
      pageId: "p1",
      kind: "text",
      tool: "signature",
      rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 },
      text: "A. Person",
      fontSize: 18,
      fontFamily: "cursive",
    });
    expect(empty.pages.p1).toEqual([]);
    expect(second.pages.p1.map(({ id }) => id)).toEqual(["a", "b"]);

    const updated = updateAnnotation(second, "a", (annotation) => ({
      ...annotation,
      color: "#ff0000",
    }));
    expect(findAnnotation(updated, "a")?.color).toBe("#ff0000");
    expect(findAnnotation(second, "a")?.color).toBe("#111111");
  });

  it("rejects duplicate IDs and identity changes during update", () => {
    const document = addAnnotation(createAnnotationDocument(), pen("same"));
    expect(() => addAnnotation(document, pen("same", "p2"))).toThrow(/already exists/);
    expect(() => updateAnnotation(document, "same", (annotation) => ({
      ...annotation,
      id: "other",
    }))).toThrow(/cannot change/);
  });

  it("normalizes input at model boundaries", () => {
    const normalized = normalizeAnnotation({
      ...pen("clamped"),
      opacity: 2,
      strokes: [[{ x: -1, y: 2, pressure: 3 }]],
    }) as InkAnnotation;
    expect(normalized.opacity).toBe(1);
    expect(normalized.strokes).toEqual([[{ x: 0, y: 1, pressure: 1 }]]);
    expect(() => normalizeAnnotation({ ...pen("empty"), strokes: [] })).toThrow(/at least one/);
  });

  it("deletes annotations without touching unrelated pages", () => {
    let document = addAnnotation(createAnnotationDocument(["p1", "p2"]), pen("a"));
    document = addAnnotation(document, pen("b", "p2"));
    const result = deleteAnnotations(document, ["a"]);
    expect(result.pages.p1).toEqual([]);
    expect(result.pages.p2.map(({ id }) => id)).toEqual(["b"]);
  });
});

describe("annotation duplication and page identity", () => {
  it("duplicates selected objects with new IDs and a safe offset", () => {
    const original = addAnnotation(createAnnotationDocument(["p1"]), pen("a"));
    const result = duplicateAnnotations(original, "p1", ["a"], () => "a-copy");
    expect(result.pages.p1.map(({ id }) => id)).toEqual(["a", "a-copy"]);
    expect((result.pages.p1[1] as InkAnnotation).strokes[0][0]).toEqual({
      x: 0.12000000000000001,
      y: 0.18000000000000002,
      pressure: 0.4,
    });
    expect((original.pages.p1[0] as InkAnnotation).strokes[0][0]).toEqual({
      x: 0.1,
      y: 0.2,
      pressure: 0.4,
    });
  });

  it("deep-clones annotations for duplicated pages", () => {
    const original = addAnnotation(createAnnotationDocument(["p1", "p2"]), pen("a"));
    const duplicated = duplicatePageAnnotations(original, "p1", "p3", () => "a-on-p3");
    expect(duplicated.pages.p3[0]).toMatchObject({ id: "a-on-p3", pageId: "p3" });
    expect(duplicated.pages.p3[0]).not.toBe(duplicated.pages.p1[0]);
    expect((duplicated.pages.p3[0] as InkAnnotation).strokes).not.toBe(
      (duplicated.pages.p1[0] as InkAnnotation).strokes,
    );
    expect((duplicated.pages.p3[0] as InkAnnotation).strokes[0]).not.toBe(
      (duplicated.pages.p1[0] as InkAnnotation).strokes[0],
    );
  });

  it("keeps page association stable across organizer order changes", () => {
    let document = addAnnotation(createAnnotationDocument(["p1", "p2"]), pen("a", "p1"));
    document = addAnnotation(document, pen("b", "p2"));
    const ordered = annotationsForPageOrder(document, ["p2", "p1"]);
    expect(ordered.map((items) => items.map(({ id }) => id))).toEqual([["b"], ["a"]]);
    expect(getPageAnnotations(document, "p1")[0].pageId).toBe("p1");
  });

  it("removes all data for a deleted page occurrence", () => {
    const document = addAnnotation(createAnnotationDocument(["p1", "p2"]), pen("a"));
    const result = removeAnnotationPage(document, "p1");
    expect(result.pages.p1).toBeUndefined();
    expect(result.pages.p2).toEqual([]);
  });
});

describe("whole-object eraser", () => {
  const viewport = {
    rotation: 0 as const,
    crop: null,
    sourceWidthPoints: 600,
    sourceHeightPoints: 800,
  };

  function overlappingDocument() {
    let document = addAnnotation(createAnnotationDocument(["p1"]), {
      ...base,
      id: "bottom",
      pageId: "p1",
      kind: "line",
      tool: "line",
      start: { x: 0.1, y: 0.5 },
      end: { x: 0.9, y: 0.5 },
    });
    document = addAnnotation(document, {
      ...base,
      id: "top",
      pageId: "p1",
      kind: "highlight",
      tool: "highlighter",
      points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    });
    return document;
  }

  it("erases only the topmost object by default", () => {
    const result = eraseAtViewportPoint(overlappingDocument(), "p1", { x: 0.5, y: 0.5 }, viewport);
    expect(result.erasedIds).toEqual(["top"]);
    expect(result.document.pages.p1.map(({ id }) => id)).toEqual(["bottom"]);
  });

  it("can erase every overlapping object", () => {
    const result = eraseAtViewportPoint(
      overlappingDocument(),
      "p1",
      { x: 0.5, y: 0.5 },
      viewport,
      { all: true },
    );
    expect(result.erasedIds).toEqual(["top", "bottom"]);
    expect(result.document.pages.p1).toEqual([]);
  });
});
