import { describe, expect, it } from "vitest";
import {
  canRedoAnnotations,
  canUndoAnnotations,
  commitAnnotationHistory,
  createAnnotationHistory,
  estimateAnnotationDocumentCost,
  redoAnnotationHistory,
  resetAnnotationHistory,
  undoAnnotationHistory,
} from "./history";
import { addAnnotation, createAnnotationDocument } from "./model";
import type { AnnotationDocument } from "./types";

function withText(document: AnnotationDocument, id: string, text = id): AnnotationDocument {
  return addAnnotation(document, {
    id,
    pageId: "p1",
    kind: "text",
    tool: "text",
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    text,
    fontSize: 12,
    color: "#111111",
    opacity: 1,
    width: 0,
  });
}

describe("bounded annotation history", () => {
  it("undoes and redoes complete annotation interactions", () => {
    const empty = createAnnotationDocument(["p1"]);
    let history = createAnnotationHistory(empty);
    history = commitAnnotationHistory(history, withText(history.present, "a"));
    history = commitAnnotationHistory(history, withText(history.present, "b"));
    expect(canUndoAnnotations(history)).toBe(true);
    expect(history.present.pages.p1.map(({ id }) => id)).toEqual(["a", "b"]);

    history = undoAnnotationHistory(history);
    expect(history.present.pages.p1.map(({ id }) => id)).toEqual(["a"]);
    expect(canRedoAnnotations(history)).toBe(true);

    history = redoAnnotationHistory(history);
    expect(history.present.pages.p1.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("drops redo history after a new branch", () => {
    let history = createAnnotationHistory(createAnnotationDocument(["p1"]));
    history = commitAnnotationHistory(history, withText(history.present, "a"));
    history = commitAnnotationHistory(history, withText(history.present, "b"));
    history = undoAnnotationHistory(history);
    history = commitAnnotationHistory(history, withText(history.present, "c"));
    expect(canRedoAnnotations(history)).toBe(false);
    expect(history.present.pages.p1.map(({ id }) => id)).toEqual(["a", "c"]);
  });

  it("keeps only the newest configured undo entries", () => {
    let history = createAnnotationHistory(createAnnotationDocument(["p1"]), { maxEntries: 2 });
    for (const id of ["a", "b", "c"]) {
      history = commitAnnotationHistory(history, withText(history.present, id));
    }
    expect(history.past).toHaveLength(2);
    history = undoAnnotationHistory(history);
    history = undoAnnotationHistory(history);
    expect(history.present.pages.p1.map(({ id }) => id)).toEqual(["a"]);
    expect(canUndoAnnotations(history)).toBe(false);
  });

  it("enforces approximate cost while retaining the newest oversized snapshot", () => {
    let history = createAnnotationHistory(createAnnotationDocument(["p1"]), {
      maxEntries: 10,
      maxCost: 1,
    });
    history = commitAnnotationHistory(history, withText(history.present, "a", "long text"));
    history = commitAnnotationHistory(history, withText(history.present, "b", "more long text"));
    expect(history.past).toHaveLength(1);
    expect(estimateAnnotationDocumentCost(history.past[0])).toBeGreaterThan(1);
  });

  it("deep-clones snapshots and can reset history", () => {
    const initial = withText(createAnnotationDocument(["p1"]), "a");
    let history = createAnnotationHistory(initial);
    initial.pages.p1[0].color = "#ffffff";
    expect(history.present.pages.p1[0].color).toBe("#111111");

    history = commitAnnotationHistory(history, withText(history.present, "b"));
    history = resetAnnotationHistory(history, createAnnotationDocument(["p1"]));
    expect(history.past).toEqual([]);
    expect(history.future).toEqual([]);
    expect(history.present.pages.p1).toEqual([]);
  });
});

