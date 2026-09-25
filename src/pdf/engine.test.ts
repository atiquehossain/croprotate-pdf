import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import type { PdfRect } from "../types";
import { PdfEngine } from "./engine";

function createOnePagePdf(): Uint8Array {
  const document = new mupdf.PDFDocument();
  const pageObject = document.addPage([0, 0, 400, 600], 0, {}, new Uint8Array());
  document.insertPage(-1, pageObject);
  pageObject.destroy();
  const buffer = document.saveToBuffer("compress");
  const bytes = new Uint8Array(buffer.asUint8Array().slice());
  buffer.destroy();
  document.destroy();
  return bytes;
}

function readRect(object: mupdf.PDFObject, key: string): PdfRect | null {
  const value = object.getInheritable(key);
  try {
    const raw = value.asJS();
    return Array.isArray(raw) && raw.length === 4
      ? [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3])]
      : null;
  } finally {
    value.destroy();
  }
}

describe("PdfEngine", () => {
  it("renders and exports rotation plus a non-destructive CropBox", async () => {
    const engine = await PdfEngine.open(createOnePagePdf());
    expect(engine.pageInfos).toHaveLength(1);
    expect(engine.pageInfos[0].sourceWidthPoints).toBe(400);
    expect(engine.pageInfos[0].sourceHeightPoints).toBe(600);

    const preview = engine.renderPage(0, 0, 0.5);
    expect([preview.width, preview.height]).toEqual([200, 300]);

    const exported = await engine.exportPdf([
      { rotation: 90, crop: [0.1, 0.2, 0.8, 0.9] },
    ]);
    const verification = new mupdf.PDFDocument(exported);
    const page = verification.loadPage(0);
    const pageObject = page.getObject();
    try {
      expect(readRect(pageObject, "MediaBox")).toEqual([0, 0, 400, 600]);
      expect(readRect(pageObject, "CropBox")).toEqual([40, 120, 320, 540]);
      const rotateObject = pageObject.getInheritable("Rotate");
      try {
        expect(rotateObject.asNumber()).toBe(90);
      } finally {
        rotateObject.destroy();
      }
    } finally {
      pageObject.destroy();
      page.destroy();
      verification.destroy();
      engine.close();
    }
  });
});
