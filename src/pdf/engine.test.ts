import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import type { PdfRect } from "../types";
import { PdfEngine } from "./engine";

function createOnePagePdf(): Uint8Array {
  return createPdf([[400, 600]]);
}

function createPdf(sizes: Array<[number, number]>): Uint8Array {
  const document = new mupdf.PDFDocument();
  for (const [width, height] of sizes) {
    const pageObject = document.addPage([0, 0, width, height], 0, {}, new Uint8Array());
    document.insertPage(-1, pageObject);
    pageObject.destroy();
  }
  const buffer = document.saveToBuffer("compress");
  const bytes = new Uint8Array(buffer.asUint8Array().slice());
  buffer.destroy();
  document.destroy();
  return bytes;
}

function createRestrictedPdf(userPassword = "", permissions = mupdf.PDFDocument.PERMISSION.print): Uint8Array {
  const document = new mupdf.PDFDocument();
  const pageObject = document.addPage([0, 0, 200, 300], 0, {}, new Uint8Array());
  document.insertPage(-1, pageObject);
  pageObject.destroy();
  const buffer = document.saveToBuffer(
    `compress,encrypt=aes-256,owner-password=owner,user-password=${userPassword},permissions=${permissions}`,
  );
  const bytes = new Uint8Array(buffer.asUint8Array().slice());
  buffer.destroy();
  document.destroy();
  return bytes;
}

function createLargeUserUnitPdf(): Uint8Array {
  const document = new mupdf.PDFDocument();
  const pageObject = document.addPage([0, 0, 100, 200], 0, {}, new Uint8Array());
  pageObject.put("UserUnit", 1_000)?.destroy?.();
  document.insertPage(-1, pageObject);
  pageObject.destroy();
  const buffer = document.saveToBuffer("compress");
  const bytes = new Uint8Array(buffer.asUint8Array().slice());
  buffer.destroy();
  document.destroy();
  return bytes;
}

function createPasswordProtectedPdf(): Uint8Array {
  const document = new mupdf.PDFDocument();
  const pageObject = document.addPage([0, 0, 200, 300], 0, {}, new Uint8Array());
  document.insertPage(-1, pageObject);
  pageObject.destroy();
  const buffer = document.saveToBuffer(
    "compress,encrypt=aes-256,owner-password=owner,user-password=user",
  );
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

function readNumber(object: mupdf.PDFObject, key: string): number {
  const value = object.getInheritable(key);
  try {
    return value.asNumber();
  } finally {
    value.destroy();
  }
}

describe("PdfEngine", () => {
  it("requires the owner password when an encrypted PDF has an empty user password", async () => {
    const bytes = createRestrictedPdf();
    const restricted = await PdfEngine.open(bytes);
    try {
      expect(restricted.encrypted).toBe(true);
      expect(restricted.canEdit).toBe(false);
    } finally {
      restricted.close();
    }

    const unlocked = await PdfEngine.open(bytes, "owner");
    try {
      expect(unlocked.encrypted).toBe(true);
      expect(unlocked.canEdit).toBe(true);
      expect(unlocked.canAssemble).toBe(true);
      expect(unlocked.canCopy).toBe(true);
      const reorganized = await unlocked.reorganize([0]);
      expect(reorganized.encrypted).toBe(true);
      expect(reorganized.requiresPassword).toBe(false);
      reorganized.close();
    } finally {
      unlocked.close();
    }
  });

  it("honors copy and assembly permissions for organizer operations", async () => {
    const limited = await PdfEngine.open(createRestrictedPdf("user", 8), "user");
    const destination = await PdfEngine.open(createOnePagePdf());
    try {
      expect(limited.canEdit).toBe(true);
      expect(limited.canAssemble).toBe(false);
      expect(limited.canCopy).toBe(false);
      await expect(limited.reorganize([0])).rejects.toThrow("page assembly");
      await expect(destination.append([limited])).rejects.toThrow("content copying");
    } finally {
      destination.close();
      limited.close();
    }
  });

  it("blocks merges that would remove a source PDF's open password", async () => {
    const destination = await PdfEngine.open(createOnePagePdf());
    const encryptedWithoutOpenPassword = await PdfEngine.open(createRestrictedPdf(), "owner");
    const protectedSource = await PdfEngine.open(createPasswordProtectedPdf(), "user");
    try {
      expect(destination.requiresPassword).toBe(false);
      expect(encryptedWithoutOpenPassword.encrypted).toBe(true);
      expect(encryptedWithoutOpenPassword.requiresPassword).toBe(false);
      expect(protectedSource.requiresPassword).toBe(true);
      expect(protectedSource.canCopy).toBe(true);
      await expect(destination.append([protectedSource])).rejects.toThrow("required open password");
      await expect(encryptedWithoutOpenPassword.append([protectedSource])).rejects.toThrow("required open password");
    } finally {
      protectedSource.close();
      encryptedWithoutOpenPassword.close();
      destination.close();
    }
  });

  it("retains a required open password through merge, reorder, and export", async () => {
    const protectedBase = await PdfEngine.open(createPasswordProtectedPdf(), "user");
    const added = await PdfEngine.open(createOnePagePdf());
    let merged: PdfEngine | null = null;
    let reordered: PdfEngine | null = null;
    try {
      merged = await protectedBase.append([added]);
      expect(merged.encrypted).toBe(true);
      expect(merged.requiresPassword).toBe(true);
      reordered = await merged.reorganize([1, 0]);
      expect(reordered.encrypted).toBe(true);
      expect(reordered.requiresPassword).toBe(true);
      const bytes = await reordered.exportPdf([
        { rotation: 0, crop: null },
        { rotation: 0, crop: null },
      ]);
      const verification = new mupdf.PDFDocument(bytes);
      try {
        expect(verification.needsPassword()).toBe(true);
        expect(verification.authenticatePassword("user")).toBeGreaterThan(0);
        expect(verification.countPages()).toBe(2);
      } finally {
        verification.destroy();
      }
    } finally {
      reordered?.close();
      merged?.close();
      added.close();
      protectedBase.close();
    }
  });

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

  it("caps preview pixels for pages with very large UserUnit values", async () => {
    const engine = await PdfEngine.open(createLargeUserUnitPdf());
    try {
      const preview = engine.renderPage(0, 0, 0.5);
      expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(3_200);
      expect(preview.width * preview.height).toBeLessThanOrEqual(5_010_000);
    } finally {
      engine.close();
    }
  });

  it("appends pages from other PDFs in source order", async () => {
    const first = await PdfEngine.open(createPdf([[100, 200], [110, 210]]));
    const second = await PdfEngine.open(createPdf([[300, 400], [310, 410]]));
    const third = await PdfEngine.open(createPdf([[500, 600]]));
    let merged: PdfEngine | null = null;
    try {
      merged = await first.append([second, third]);
      expect(merged.pageInfos.map((page) => [page.sourceWidthPoints, page.sourceHeightPoints])).toEqual([
        [100, 200],
        [110, 210],
        [300, 400],
        [310, 410],
        [500, 600],
      ]);
    } finally {
      merged?.close();
      third.close();
      second.close();
      first.close();
    }
  });

  it("reorders and removes pages without changing their contents", async () => {
    const engine = await PdfEngine.open(createPdf([[100, 200], [200, 300], [300, 400]]));
    let reorganized: PdfEngine | null = null;
    try {
      reorganized = await engine.reorganize([2, 0]);
      expect(reorganized.pageInfos.map((page) => [page.sourceWidthPoints, page.sourceHeightPoints])).toEqual([
        [300, 400],
        [100, 200],
      ]);
    } finally {
      reorganized?.close();
      engine.close();
    }
  });

  it("extracts selected pages in document order with their edits", async () => {
    const engine = await PdfEngine.open(createPdf([[100, 200], [200, 300], [300, 400]]));
    try {
      const exported = await engine.exportPdf(
        [
          { rotation: 90, crop: null },
          { rotation: 0, crop: null },
          { rotation: 180, crop: [0.1, 0.2, 0.9, 0.8] },
        ],
        [0, 2],
      );
      const verification = new mupdf.PDFDocument(exported);
      try {
        expect(verification.countPages()).toBe(2);
        const firstPage = verification.loadPage(0);
        const secondPage = verification.loadPage(1);
        const firstObject = firstPage.getObject();
        const secondObject = secondPage.getObject();
        try {
          expect(readRect(firstObject, "MediaBox")).toEqual([0, 0, 100, 200]);
          expect(readRect(secondObject, "MediaBox")).toEqual([0, 0, 300, 400]);
          expect(readRect(secondObject, "CropBox")).toEqual([30, 80, 270, 320]);
          expect(readNumber(firstObject, "Rotate")).toBe(90);
          expect(readNumber(secondObject, "Rotate")).toBe(180);
        } finally {
          firstObject.destroy();
          secondObject.destroy();
          firstPage.destroy();
          secondPage.destroy();
        }
      } finally {
        verification.destroy();
      }
    } finally {
      engine.close();
    }
  });
});
