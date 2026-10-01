import { describe, expect, it, vi } from "vitest";
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

function createPasswordProtectedPdf(
  sizes: Array<[number, number]> = [[200, 300]],
): Uint8Array {
  const document = new mupdf.PDFDocument();
  for (const [width, height] of sizes) {
    const pageObject = document.addPage([0, 0, width, height], 0, {}, new Uint8Array());
    document.insertPage(-1, pageObject);
    pageObject.destroy();
  }
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

  it("duplicates pages when the organized page order repeats an index", async () => {
    const engine = await PdfEngine.open(createPdf([[100, 200], [300, 400]]));
    let organized: PdfEngine | null = null;
    try {
      organized = await engine.reorganize([1, 0, 1]);
      expect(organized.pageInfos.map((page) => [page.sourceWidthPoints, page.sourceHeightPoints])).toEqual([
        [300, 400],
        [100, 200],
        [300, 400],
      ]);
    } finally {
      organized?.close();
      engine.close();
    }
  });

  it("retains crop and rotation edits on duplicated exported pages", async () => {
    const engine = await PdfEngine.open(createOnePagePdf());
    try {
      const exported = await engine.exportPdf(
        [{ rotation: 90, crop: [0.1, 0.2, 0.8, 0.9] }],
        [0, 0],
      );
      const verification = new mupdf.PDFDocument(exported);
      try {
        expect(verification.countPages()).toBe(2);
        for (let index = 0; index < 2; index += 1) {
          const page = verification.loadPage(index);
          const pageObject = page.getObject();
          try {
            expect(readRect(pageObject, "CropBox")).toEqual([40, 120, 320, 540]);
            expect(readNumber(pageObject, "Rotate")).toBe(90);
          } finally {
            pageObject.destroy();
            page.destroy();
          }
        }
      } finally {
        verification.destroy();
      }
    } finally {
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

  it("only edits emitted pages while preserving ordered duplicate mappings and progress", async () => {
    const engine = await PdfEngine.open(createPdf([
      [100, 200],
      [200, 300],
      [300, 400],
      [400, 500],
      [500, 600],
    ]));
    const loadPage = vi.spyOn(mupdf.PDFDocument.prototype, "loadPage");
    const progress: Array<[string, number, number]> = [];
    try {
      loadPage.mockClear();
      const exported = await engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 90, crop: [0.2, 0.1, 0.9, 0.8] },
          { rotation: 0, crop: null },
          { rotation: 0, crop: null },
          { rotation: 270, crop: [0.1, 0.2, 0.8, 0.9] },
        ],
        [4, 1, 4],
        {
          onProgress: (update) => {
            progress.push([update.stage, update.completed, update.total]);
          },
        },
      );

      // Export work is proportional to emitted pages, not the five-page source.
      expect(loadPage.mock.calls.map(([pageIndex]) => pageIndex)).toEqual([0, 1, 2]);
      expect(progress).toEqual([
        ["applying-edits", 0, 5],
        ["applying-edits", 1, 5],
        ["applying-edits", 2, 5],
        ["applying-edits", 3, 5],
        ["saving", 4, 5],
        ["ready", 5, 5],
      ]);

      const verification = new mupdf.PDFDocument(exported);
      try {
        expect(verification.countPages()).toBe(3);
        const expected = [
          { media: [0, 0, 500, 600], crop: [50, 120, 400, 540], rotation: 270 },
          { media: [0, 0, 200, 300], crop: [40, 30, 180, 240], rotation: 90 },
          { media: [0, 0, 500, 600], crop: [50, 120, 400, 540], rotation: 270 },
        ];
        for (const [index, expectedPage] of expected.entries()) {
          const page = verification.loadPage(index);
          const pageObject = page.getObject();
          try {
            expect(readRect(pageObject, "MediaBox")).toEqual(expectedPage.media);
            expect(readRect(pageObject, "CropBox")).toEqual(expectedPage.crop);
            expect(readNumber(pageObject, "Rotate")).toBe(expectedPage.rotation);
          } finally {
            pageObject.destroy();
            page.destroy();
          }
        }
      } finally {
        verification.destroy();
      }
    } finally {
      loadPage.mockRestore();
      engine.close();
    }
  });

  it("keeps password protection when exporting an edited page subset", async () => {
    const engine = await PdfEngine.open(
      createPasswordProtectedPdf([[100, 200], [300, 400]]),
      "user",
    );
    try {
      const exported = await engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 180, crop: [0.1, 0.2, 0.9, 0.8] },
        ],
        [1],
      );
      const verification = new mupdf.PDFDocument(exported);
      try {
        expect(verification.needsPassword()).toBe(true);
        expect(verification.authenticatePassword("user")).toBeGreaterThan(0);
        expect(verification.countPages()).toBe(1);
        const page = verification.loadPage(0);
        const pageObject = page.getObject();
        try {
          expect(readRect(pageObject, "MediaBox")).toEqual([0, 0, 300, 400]);
          expect(readRect(pageObject, "CropBox")).toEqual([30, 80, 270, 320]);
          expect(readNumber(pageObject, "Rotate")).toBe(180);
        } finally {
          pageObject.destroy();
          page.destroy();
        }
      } finally {
        verification.destroy();
      }
    } finally {
      engine.close();
    }
  });

  it("reports progress and cooperatively cancels a multi-page export", async () => {
    const engine = await PdfEngine.open(createPdf([[100, 200], [200, 300], [300, 400]]));
    const controller = new AbortController();
    const progress: Array<[string, number, number]> = [];
    try {
      const exporting = engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 0, crop: null },
          { rotation: 0, crop: null },
        ],
        undefined,
        {
          signal: controller.signal,
          onProgress: (update) => {
            progress.push([update.stage, update.completed, update.total]);
            if (update.stage === "applying-edits" && update.completed === 1) {
              controller.abort();
            }
          },
        },
      );
      await expect(exporting).rejects.toMatchObject({ name: "AbortError" });
      expect(progress).toContainEqual(["applying-edits", 1, 5]);
      expect(progress.some(([stage]) => stage === "ready")).toBe(false);
    } finally {
      engine.close();
    }
  });

  it("cooperatively cancels during the emitted-page loop of an ordered export", async () => {
    const engine = await PdfEngine.open(createPdf([
      [100, 200],
      [200, 300],
      [300, 400],
      [400, 500],
    ]));
    const controller = new AbortController();
    const progress: Array<[string, number, number]> = [];
    try {
      const exporting = engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 90, crop: null },
          { rotation: 180, crop: null },
          { rotation: 270, crop: null },
        ],
        [3, 1],
        {
          signal: controller.signal,
          onProgress: (update) => {
            progress.push([update.stage, update.completed, update.total]);
            if (update.stage === "applying-edits" && update.completed === 1) {
              controller.abort();
            }
          },
        },
      );
      await expect(exporting).rejects.toMatchObject({ name: "AbortError" });
      expect(progress).toEqual([
        ["applying-edits", 0, 4],
        ["applying-edits", 1, 4],
      ]);
    } finally {
      engine.close();
    }
  });

  it("restores an encrypted snapshot without asking the caller for its password again", async () => {
    const engine = await PdfEngine.open(createPasswordProtectedPdf(), "user");
    let reorganized: PdfEngine | null = null;
    let restored: PdfEngine | null = null;
    try {
      const snapshot = engine.snapshotBytes();
      reorganized = await engine.reorganize([0]);
      restored = await reorganized.restoreSnapshot(snapshot);
      expect(restored.encrypted).toBe(true);
      expect(restored.requiresPassword).toBe(true);
      expect(restored.pageInfos).toHaveLength(1);
      const exported = await restored.exportPdf([{ rotation: 0, crop: null }]);
      const verification = new mupdf.PDFDocument(exported);
      try {
        expect(verification.needsPassword()).toBe(true);
        expect(verification.authenticatePassword("user")).toBeGreaterThan(0);
      } finally {
        verification.destroy();
      }
    } finally {
      restored?.close();
      reorganized?.close();
      engine.close();
    }
  });
});
