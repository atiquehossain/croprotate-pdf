import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import type { Annotation } from "../annotations/types";
import { PdfEngine } from "./engine";
import {
  parseAnnotationColor,
  markStrokesToPage,
  sourcePointToPagePoint,
  sourceRectToPageRect,
  physicalPointsToPdfUnits,
} from "./annotationExport";

function createProtectedPdfWithOriginalComment(): Uint8Array {
  const document = new mupdf.PDFDocument();
  for (let index = 0; index < 2; index += 1) {
    const pageObject = document.addPage([10, 20, 410, 420], 0, {}, new Uint8Array());
    pageObject.put("CropBox", [20, 30, 400, 410])?.destroy?.();
    document.insertPage(-1, pageObject);
    pageObject.destroy();
  }
  const page = document.loadPage(0);
  const existing = page.createAnnotation("Text");
  existing.setRect([10, 10, 35, 35]);
  existing.setContents("Original comment");
  existing.setFlags(existing.getFlags() | mupdf.PDFAnnotation.IS_PRINT);
  existing.update();
  page.update();
  existing.destroy();
  page.destroy();
  const buffer = document.saveToBuffer(
    "compress,encrypt=aes-256,owner-password=owner,user-password=user",
  );
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  document.destroy();
  return bytes;
}

function createFourPageUserUnitPdf(): Uint8Array {
  const document = new mupdf.PDFDocument();
  for (let index = 0; index < 4; index += 1) {
    const pageObject = document.addPage([10, 20, 410, 420], 0, {}, new Uint8Array());
    pageObject.put("CropBox", [20, 30, 400, 410])?.destroy?.();
    pageObject.put("UserUnit", 2)?.destroy?.();
    document.insertPage(-1, pageObject);
    pageObject.destroy();
  }
  const buffer = document.saveToBuffer("compress");
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  document.destroy();
  return bytes;
}

function createMixedUserUnitPdf(): Uint8Array {
  const document = new mupdf.PDFDocument();
  const pageOne = document.addPage([0, 0, 400, 400], 0, {}, new Uint8Array());
  document.insertPage(-1, pageOne);
  pageOne.destroy();
  const pageTwo = document.addPage([0, 0, 200, 200], 0, {}, new Uint8Array());
  pageTwo.put("UserUnit", 2)?.destroy?.();
  document.insertPage(-1, pageTwo);
  pageTwo.destroy();
  const buffer = document.saveToBuffer("compress");
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  document.destroy();
  return bytes;
}

function annotationBase(id: string, color: string, width = 5) {
  return { id, pageId: "page-a", color, opacity: 1, width };
}

function pageZeroAnnotations(): Annotation[] {
  return [
    {
      ...annotationBase("pen", "#e00000"),
      kind: "ink",
      tool: "pen",
      strokes: [[{ x: 0.1, y: 0.86 }, { x: 0.25, y: 0.76 }, { x: 0.38, y: 0.88 }]],
    },
    {
      ...annotationBase("highlight", "rgba(255, 225, 0, 0.8)", 16),
      opacity: 0.45,
      kind: "highlight",
      tool: "highlighter",
      points: [{ x: 0.08, y: 0.67 }, { x: 0.4, y: 0.67 }],
    },
    {
      ...annotationBase("text", "blue", 1),
      kind: "text",
      tool: "text",
      rect: { x: 0.52, y: 0.73, width: 0.38, height: 0.18 },
      text: "Approved locally",
      fontSize: 18,
      fontFamily: "sans-serif",
      align: "center",
    },
    {
      ...annotationBase("check", "#008000", 6),
      kind: "mark",
      tool: "check",
      rect: { x: 0.08, y: 0.42, width: 0.18, height: 0.18 },
    },
    {
      ...annotationBase("cross", "#cc00cc", 5),
      kind: "mark",
      tool: "cross",
      rect: { x: 0.3, y: 0.42, width: 0.18, height: 0.18 },
    },
    {
      ...annotationBase("line", "#ff6600", 4),
      kind: "line",
      tool: "line",
      start: { x: 0.55, y: 0.57 },
      end: { x: 0.88, y: 0.45 },
    },
    {
      ...annotationBase("arrow", "#00a0c0", 4),
      kind: "line",
      tool: "arrow",
      start: { x: 0.55, y: 0.38 },
      end: { x: 0.88, y: 0.26 },
    },
    {
      ...annotationBase("rect", "#7020a0", 5),
      kind: "shape",
      tool: "rectangle",
      rect: { x: 0.08, y: 0.1, width: 0.32, height: 0.22 },
      fillColor: "#d8b4fe",
      fillOpacity: 0.3,
    },
    {
      ...annotationBase("ellipse", "#743500", 5),
      kind: "shape",
      tool: "ellipse",
      rect: { x: 0.55, y: 0.05, width: 0.33, height: 0.2 },
    },
  ];
}

function pageOneAnnotations(): Annotation[] {
  return [
    {
      ...annotationBase("signature", "#111111", 4),
      pageId: "page-b",
      kind: "ink",
      tool: "signature",
      strokes: [
        [
          { x: 0.14, y: 0.45 },
          { x: 0.28, y: 0.62 },
          { x: 0.42, y: 0.38 },
        ],
        [
          { x: 0.45, y: 0.42 },
          { x: 0.55, y: 0.6 },
          { x: 0.74, y: 0.43 },
        ],
      ],
    },
    {
      ...annotationBase("date", "#153e75", 1),
      pageId: "page-b",
      kind: "text",
      tool: "date",
      rect: { x: 0.2, y: 0.16, width: 0.6, height: 0.14 },
      text: "2030-04-15",
      fontSize: 20,
    },
    {
      ...annotationBase("typed-signature", "#111111", 1),
      pageId: "page-b",
      kind: "text",
      tool: "signature",
      rect: { x: 0.2, y: 0.72, width: 0.6, height: 0.14 },
      text: "Atique Hossain",
      fontSize: 22,
      fontFamily: "cursive",
    },
  ];
}

function coloredPixelCount(page: mupdf.PDFPage): number {
  const pixmap = page.toPixmap(
    mupdf.Matrix.identity,
    mupdf.ColorSpace.DeviceRGB,
    true,
    false,
    "View",
    "CropBox",
  );
  try {
    const pixels = pixmap.getPixels();
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index + 3] > 0 &&
        (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)
      ) {
        count += 1;
      }
    }
    return count;
  } finally {
    pixmap.destroy();
  }
}

function hasDarkPixelsNear(
  pixels: Uint8ClampedArray<ArrayBufferLike>,
  width: number,
  height: number,
  point: readonly [number, number],
  radius = 8,
): boolean {
  const left = Math.max(0, Math.floor(point[0] - radius));
  const right = Math.min(width - 1, Math.ceil(point[0] + radius));
  const top = Math.max(0, Math.floor(point[1] - radius));
  const bottom = Math.min(height - 1, Math.ceil(point[1] + radius));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * width + x) * 4;
      if (
        pixels[offset + 3] > 32 &&
        pixels[offset] < 160 &&
        pixels[offset + 1] < 160 &&
        pixels[offset + 2] < 160
      ) return true;
    }
  }
  return false;
}

function darkVerticalRun(
  pixels: Uint8ClampedArray<ArrayBufferLike>,
  width: number,
  x: number,
  fromY: number,
  toY: number,
): number {
  let count = 0;
  for (let y = fromY; y <= toY; y += 1) {
    const offset = (y * width + x) * 4;
    if (
      pixels[offset + 3] > 32 &&
      pixels[offset] < 160 &&
      pixels[offset + 1] < 160 &&
      pixels[offset + 2] < 160
    ) count += 1;
  }
  return count;
}

function darkBoundsHeight(
  pixels: Uint8ClampedArray<ArrayBufferLike>,
  width: number,
  height: number,
  region: readonly [number, number, number, number],
): number {
  let minimumY = height;
  let maximumY = -1;
  for (let y = region[1]; y <= region[3]; y += 1) {
    for (let x = region[0]; x <= region[2]; x += 1) {
      const offset = (y * width + x) * 4;
      if (
        pixels[offset + 3] > 32 &&
        pixels[offset] < 160 &&
        pixels[offset + 1] < 160 &&
        pixels[offset + 2] < 160
      ) {
        minimumY = Math.min(minimumY, y);
        maximumY = Math.max(maximumY, y);
      }
    }
  }
  return maximumY < minimumY ? 0 : maximumY - minimumY + 1;
}

describe("annotation PDF export helpers", () => {
  it("parses worker-safe CSS colors and their alpha", () => {
    expect(parseAnnotationColor("#369")).toEqual({
      color: [0.2, 0.4, 0.6],
      alpha: 1,
    });
    expect(parseAnnotationColor("rgba(255, 128, 0, 25%)")).toEqual({
      color: [1, 128 / 255, 0],
      alpha: 0.25,
    });
    expect(parseAnnotationColor("transparent").alpha).toBe(0);
    expect(() => parseAnnotationColor("url(https://example.invalid/color)")).toThrow(
      "Unsupported annotation color",
    );
  });

  it("converts physical annotation points into PDF user units", () => {
    expect(physicalPointsToPdfUnits(12, 1)).toBe(12);
    expect(physicalPointsToPdfUnits(12, 2)).toBe(6);
    expect(physicalPointsToPdfUnits(12, 0.5)).toBe(24);
    expect(() => physicalPointsToPdfUnits(12, 0)).toThrow("UserUnit");
  });

  it("maps source-normalized points and rectangles through the page transform", () => {
    const crop: [number, number, number, number] = [10, 20, 210, 320];
    const transform: [number, number, number, number, number, number] = [0, 1, 1, 0, -20, -10];
    expect(sourcePointToPagePoint({ x: 0.25, y: 0.5 }, crop, transform)).toEqual([150, 50]);
    const mappedRect = sourceRectToPageRect(
      { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      crop,
      transform,
    );
    expect(mappedRect[0]).toBeCloseTo(60);
    expect(mappedRect[1]).toBeCloseTo(20);
    expect(mappedRect[2]).toBeCloseTo(180);
    expect(mappedRect[3]).toBeCloseTo(80);
  });

  it.each([
    ["0°", [2, 0, 0, -2, -40, 820]],
    ["90°", [0, 2, 2, 0, -60, -40]],
    ["180°", [-2, 0, 0, 2, 800, -60]],
    ["270°", [0, -2, -2, 0, 820, 800]],
  ] as const)("keeps check and cross glyphs upright in final page space at %s", (_label, matrix) => {
    const rawCropBox: [number, number, number, number] = [20, 30, 400, 410];
    const rect = { x: 0.18, y: 0.24, width: 0.53, height: 0.41 };
    const style = annotationBase("mark", "#111111", 6);
    const pageRect = sourceRectToPageRect(rect, rawCropBox, [...matrix]);
    const normalize = ([x, y]: [number, number]) => [
      Number(((x - pageRect[0]) / (pageRect[2] - pageRect[0])).toFixed(8)),
      Number(((y - pageRect[1]) / (pageRect[3] - pageRect[1])).toFixed(8)),
    ];

    const check = markStrokesToPage(
      { ...style, kind: "mark", tool: "check", rect },
      rawCropBox,
      [...matrix],
    )[0].map(normalize);
    expect(check).toEqual([
      [0.1, 0.52],
      [0.39, 0.84],
      [0.92, 0.12],
    ]);

    const cross = markStrokesToPage(
      { ...style, kind: "mark", tool: "cross", rect },
      rawCropBox,
      [...matrix],
    ).map((stroke) => stroke.map(normalize));
    expect(cross).toEqual([
      [[0.13, 0.13], [0.87, 0.87]],
      [[0.87, 0.13], [0.13, 0.87]],
    ]);
  });
});

describe("PdfEngine annotation export", () => {
  it("keeps physical stroke and font sizes stable when UserUnit is 2", async () => {
    const engine = await PdfEngine.open(createMixedUserUnitPdf());
    const annotations = engine.pageInfos.map((_, index): Annotation[] => [
      {
        ...annotationBase(`stroke-${index}`, "#111111", 12),
        pageId: `page-${index}`,
        kind: "ink",
        tool: "signature",
        strokes: [[{ x: 0.2, y: 0.78 }, { x: 0.8, y: 0.78 }]],
      },
      {
        ...annotationBase(`text-${index}`, "#111111", 1),
        pageId: `page-${index}`,
        kind: "text",
        tool: "signature",
        rect: { x: 0.15, y: 0.1, width: 0.7, height: 0.4 },
        text: "Physical size",
        fontSize: 24,
      },
    ]);
    try {
      const exported = await engine.exportPdf(
        engine.pageInfos.map(() => ({ rotation: 0, crop: null })),
        undefined,
        { annotations },
      );
      const verification = new mupdf.PDFDocument(exported);
      try {
        const strokeRuns: number[] = [];
        const textHeights: number[] = [];
        for (let index = 0; index < 2; index += 1) {
          const page = verification.loadPage(index);
          try {
            const pixmap = page.toPixmap(
              mupdf.Matrix.identity,
              mupdf.ColorSpace.DeviceRGB,
              true,
              false,
              "View",
              "CropBox",
            );
            try {
              expect(pixmap.getWidth()).toBe(400);
              expect(pixmap.getHeight()).toBe(400);
              const pixels = pixmap.getPixels();
              strokeRuns.push(darkVerticalRun(pixels, 400, 200, 65, 115));
              textHeights.push(darkBoundsHeight(pixels, 400, 400, [50, 190, 350, 365]));
            } finally {
              pixmap.destroy();
            }
          } finally {
            page.destroy();
          }
        }
        expect(strokeRuns[0]).toBeGreaterThanOrEqual(10);
        expect(Math.abs(strokeRuns[0] - strokeRuns[1])).toBeLessThanOrEqual(2);
        expect(textHeights[0]).toBeGreaterThanOrEqual(16);
        expect(Math.abs(textHeights[0] - textHeights[1])).toBeLessThanOrEqual(2);
      } finally {
        verification.destroy();
      }
    } finally {
      engine.close();
    }
  });

  it("renders check marks upright at every page rotation with crop and UserUnit", async () => {
    const engine = await PdfEngine.open(createFourPageUserUnitPdf());
    const rect = { x: 0.18, y: 0.24, width: 0.53, height: 0.41 };
    const annotations = engine.pageInfos.map((_, index): Annotation[] => [{
      ...annotationBase(`check-${index}`, "#111111", 8),
      pageId: `page-${index}`,
      kind: "mark",
      tool: "check",
      rect,
    }]);
    try {
      const rotations = [0, 90, 180, 270] as const;
      const exported = await engine.exportPdf(
        rotations.map((rotation) => ({
          rotation,
          crop: [0.05, 0.1, 0.95, 0.9],
        })),
        undefined,
        { annotations },
      );
      const verification = new mupdf.PDFDocument(exported);
      try {
        for (let index = 0; index < rotations.length; index += 1) {
          const page = verification.loadPage(index);
          try {
            const expectedStroke = markStrokesToPage(
              annotations[index][0] as Extract<Annotation, { kind: "mark" }>,
              engine.pageInfos[index].rawCropBox,
              page.getTransform(),
            )[0];
            const pixmap = page.toPixmap(
              mupdf.Matrix.identity,
              mupdf.ColorSpace.DeviceRGB,
              true,
              false,
              "View",
              "CropBox",
            );
            try {
              const pixels = pixmap.getPixels();
              for (const point of expectedStroke) {
                expect(
                  hasDarkPixelsNear(
                    pixels,
                    pixmap.getWidth(),
                    pixmap.getHeight(),
                    point,
                  ),
                  `missing upright check vertex on the ${rotations[index]}° page`,
                ).toBe(true);
              }
            } finally {
              pixmap.destroy();
            }
          } finally {
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

  it("flattens every app annotation, preserves original comments and encryption, and maps duplicates", async () => {
    const engine = await PdfEngine.open(createProtectedPdfWithOriginalComment(), "user");
    try {
      const progressStages: string[] = [];
      const exported = await engine.exportPdf(
        [
          { rotation: 90, crop: [0.04, 0.04, 0.96, 0.96] },
          { rotation: 270, crop: [0.03, 0.03, 0.97, 0.97] },
        ],
        [1, 0, 1],
        {
          annotations: [pageZeroAnnotations(), pageOneAnnotations()],
          onProgress: (progress) => progressStages.push(progress.stage),
        },
      );
      expect(progressStages).toContain("flattening-annotations");

      const verification = new mupdf.PDFDocument(exported);
      try {
        expect(verification.needsPassword()).toBe(true);
        expect(verification.authenticatePassword("user")).toBeGreaterThan(0);
        expect(verification.countPages()).toBe(3);

        const pixelCounts: number[] = [];
        for (let index = 0; index < verification.countPages(); index += 1) {
          const page = verification.loadPage(index);
          try {
            const annotations = page.getAnnotations();
            try {
              const contents = annotations.map((annotation) => annotation.getContents());
              if (index === 1) {
                expect(annotations).toHaveLength(1);
                expect(contents).toContain("Original comment");
              } else {
                expect(annotations).toHaveLength(0);
              }
            } finally {
              for (const annotation of annotations) annotation.destroy();
            }
            pixelCounts.push(coloredPixelCount(page));
            if (index === 1) {
              expect(page.search("Approved locally", {})).not.toHaveLength(0);
            }
            if (index === 0 || index === 2) {
              expect(page.search("2030-04-15", {})).not.toHaveLength(0);
              expect(page.search("Atique Hossain", {})).not.toHaveLength(0);
            }
          } finally {
            page.destroy();
          }
        }
        expect(pixelCounts.every((count) => count > 500)).toBe(true);
        expect(pixelCounts[0]).toBe(pixelCounts[2]);
      } finally {
        verification.destroy();
      }
    } finally {
      engine.close();
    }
  });

  it("validates annotation pages before touching the output", async () => {
    const engine = await PdfEngine.open(createProtectedPdfWithOriginalComment(), "user");
    try {
      await expect(engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 0, crop: null },
        ],
        undefined,
        { annotations: [[]] },
      )).rejects.toThrow("annotation list");
    } finally {
      engine.close();
    }
  });

  it("cooperatively cancels before the synchronous annotation bake", async () => {
    const engine = await PdfEngine.open(createProtectedPdfWithOriginalComment(), "user");
    const controller = new AbortController();
    try {
      const exporting = engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 0, crop: null },
        ],
        undefined,
        {
          annotations: [pageZeroAnnotations(), pageOneAnnotations()],
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "flattening-annotations") controller.abort();
          },
        },
      );
      await expect(exporting).rejects.toMatchObject({ name: "AbortError" });

      // Cancellation only discards the temporary output document.
      await expect(engine.exportPdf([
        { rotation: 0, crop: null },
        { rotation: 0, crop: null },
      ])).resolves.toBeInstanceOf(Uint8Array);
    } finally {
      engine.close();
    }
  });

  it("refuses to silently lose glyphs unsupported by the built-in PDF fonts", async () => {
    const engine = await PdfEngine.open(createProtectedPdfWithOriginalComment(), "user");
    try {
      const unsupported: Annotation = {
        ...annotationBase("unicode-text", "#111111", 1),
        kind: "text",
        tool: "signature",
        rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
        text: "আতিক",
        fontSize: 20,
      };
      await expect(engine.exportPdf(
        [
          { rotation: 0, crop: null },
          { rotation: 0, crop: null },
        ],
        undefined,
        { annotations: [[unsupported], []] },
      )).rejects.toThrow("built-in PDF font");
    } finally {
      engine.close();
    }
  });
});
