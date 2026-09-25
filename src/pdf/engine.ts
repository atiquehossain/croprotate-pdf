import * as mupdf from "mupdf";
import type {
  PageEdit,
  PageInfo,
  PdfRect,
  RenderedPage,
  Rotation,
  TrimSensitivity,
  VisualRect,
} from "../types";
import { normalizeRotation, totalRotation, visualPageDimensions } from "./geometry";

export class PasswordRequiredError extends Error {
  readonly incorrect: boolean;

  constructor(incorrect = false) {
    super(incorrect ? "That password did not unlock the PDF." : "This PDF requires a password.");
    this.name = "PasswordRequiredError";
    this.incorrect = incorrect;
  }
}

export class PdfEngine {
  readonly pageInfos: PageInfo[];
  readonly encrypted: boolean;
  readonly canEdit: boolean;

  private readonly originalBytes: Uint8Array;
  private readonly password: string | null;
  private document: mupdf.PDFDocument;

  private constructor(
    document: mupdf.PDFDocument,
    bytes: Uint8Array,
    password: string | null,
    encrypted: boolean,
  ) {
    this.document = document;
    this.originalBytes = new Uint8Array(bytes);
    this.password = password;
    this.encrypted = encrypted;
    this.canEdit = !encrypted || document.hasPermission("edit");
    this.pageInfos = this.readPageInfos();
  }

  static async open(bytes: Uint8Array, password?: string): Promise<PdfEngine> {
    await Promise.resolve();
    let document: mupdf.PDFDocument;
    try {
      document = new mupdf.PDFDocument(bytes);
    } catch (error) {
      throw new Error(
        `The file could not be opened as a PDF. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const encrypted = document.needsPassword();
    if (encrypted) {
      if (password === undefined) {
        document.destroy();
        throw new PasswordRequiredError(false);
      }
      if (!document.authenticatePassword(password)) {
        document.destroy();
        throw new PasswordRequiredError(true);
      }
    }
    try {
      if (document.countPages() < 1) throw new Error("The PDF does not contain any pages.");
      return new PdfEngine(document, bytes, encrypted ? password ?? "" : null, encrypted);
    } catch (error) {
      document.destroy();
      throw error;
    }
  }

  close(): void {
    this.document.destroy();
  }

  renderPage(
    pageIndex: number,
    editRotation: Rotation,
    scale: number,
    includeAnnotations = true,
  ): RenderedPage {
    const page = this.document.loadPage(pageIndex);
    try {
      const safeScale = Math.min(Math.max(scale, 0.03), 6);
      const matrix = mupdf.Matrix.concat(
        mupdf.Matrix.rotate(editRotation),
        mupdf.Matrix.scale(safeScale, safeScale),
      );
      const pixmap = page.toPixmap(
        matrix,
        mupdf.ColorSpace.DeviceRGB,
        true,
        includeAnnotations,
        "View",
        "CropBox",
      );
      try {
        return {
          width: pixmap.getWidth(),
          height: pixmap.getHeight(),
          pixels: new Uint8ClampedArray(pixmap.getPixels().slice()),
        };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  async autoTrim(
    pageIndex: number,
    editRotation: Rotation,
    sensitivity: TrimSensitivity,
    paddingPoints: number,
    includeAnnotations: boolean,
  ): Promise<VisualRect | null> {
    const info = this.pageInfos[pageIndex];
    const [pageWidth, pageHeight] = visualPageDimensions(
      info,
      totalRotation(info, editRotation),
    );
    const scale = Math.min(2, 1200 / Math.max(pageWidth, pageHeight));
    const rendered = this.renderPage(pageIndex, editRotation, scale, includeAnnotations);
    const tolerance = {
      "Faint text": 7,
      Balanced: 14,
      "Clean scan": 24,
    }[sensitivity];
    const worker = new Worker(new URL("./autoTrim.worker.ts", import.meta.url), {
      type: "module",
    });
    const buffer = new Uint8ClampedArray(rendered.pixels).buffer;
    return new Promise<VisualRect | null>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        worker.terminate();
        reject(new Error("Auto-trim took too long and was cancelled."));
      }, 30_000);
      worker.onmessage = (
        event: MessageEvent<
          | { ok: true; rect: VisualRect | null }
          | { ok: false; error: string }
        >,
      ) => {
        globalThis.clearTimeout(timeout);
        worker.terminate();
        if (event.data.ok) resolve(event.data.rect);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        globalThis.clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || "Auto-trim worker failed."));
      };
      worker.postMessage(
        {
          pixels: buffer,
          width: rendered.width,
          height: rendered.height,
          tolerance,
          paddingPixels: Math.ceil(paddingPoints * scale),
        },
        [buffer],
      );
    });
  }

  async exportPdf(edits: PageEdit[]): Promise<Uint8Array<ArrayBuffer>> {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
    const outputDocument = new mupdf.PDFDocument(this.originalBytes);
    let outputBuffer: mupdf.Buffer | null = null;
    try {
      if (outputDocument.needsPassword()) {
        if (!outputDocument.authenticatePassword(this.password ?? "")) {
          throw new Error("The PDF could not be authenticated for export.");
        }
      }
      if (edits.length !== outputDocument.countPages()) {
        throw new Error("The page edit list no longer matches this PDF.");
      }

      for (let index = 0; index < edits.length; index += 1) {
        const edit = edits[index];
        const info = this.pageInfos[index];
        const page = outputDocument.loadPage(index);
        try {
          const pageObject = page.getObject();
          try {
            this.putObjectValue(
              pageObject,
              "Rotate",
              normalizeRotation(info.originalRotation + edit.rotation),
            );
            if (edit.crop !== null) {
              const [left, bottom, right, top] = info.rawCropBox;
              const width = right - left;
              const height = top - bottom;
              const crop: PdfRect = [
                left + edit.crop[0] * width,
                bottom + edit.crop[1] * height,
                left + edit.crop[2] * width,
                bottom + edit.crop[3] * height,
              ];
              this.putObjectValue(pageObject, "CropBox", crop);
              this.constrainPageBoxes(pageObject, crop);
            }
          } finally {
            pageObject.destroy();
          }
        } finally {
          page.destroy();
        }
      }

      outputBuffer = outputDocument.saveToBuffer(
        "garbage=2,compress,clean,encrypt=keep",
      );
      const bytes = new Uint8Array(outputBuffer.asUint8Array().slice());
      const verification = new mupdf.PDFDocument(bytes);
      try {
        if (verification.needsPassword()) {
          if (!verification.authenticatePassword(this.password ?? "")) {
            throw new Error("The generated encrypted PDF could not be reopened.");
          }
        }
        if (verification.countPages() !== edits.length) {
          throw new Error("The generated PDF did not contain the expected pages.");
        }
      } finally {
        verification.destroy();
      }
      return bytes;
    } finally {
      outputBuffer?.destroy();
      outputDocument.destroy();
    }
  }

  private readPageInfos(): PageInfo[] {
    const infos: PageInfo[] = [];
    for (let index = 0; index < this.document.countPages(); index += 1) {
      const page = this.document.loadPage(index);
      try {
        const pageObject = page.getObject();
        try {
          const mediaBox = this.readRect(pageObject, "MediaBox") ?? [0, 0, 612, 792];
          const cropBox = this.readRect(pageObject, "CropBox") ?? mediaBox;
          const rotationValue = this.readNumber(pageObject, "Rotate", 0);
          const userUnit = Math.max(this.readNumber(pageObject, "UserUnit", 1), 0.01);
          infos.push({
            index,
            label: page.getLabel() || String(index + 1),
            originalRotation: normalizeRotation(rotationValue),
            rawCropBox: [...cropBox],
            rawMediaBox: [...mediaBox],
            userUnit,
            sourceWidthPoints: Math.abs(cropBox[2] - cropBox[0]) * userUnit,
            sourceHeightPoints: Math.abs(cropBox[3] - cropBox[1]) * userUnit,
          });
        } finally {
          pageObject.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return infos;
  }

  private readRect(object: mupdf.PDFObject, key: string): PdfRect | null {
    const value = object.getInheritable(key);
    try {
      const raw = value.asJS();
      if (
        Array.isArray(raw) &&
        raw.length === 4 &&
        raw.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ) {
        return [raw[0], raw[1], raw[2], raw[3]];
      }
      return null;
    } finally {
      value.destroy();
    }
  }

  private readNumber(
    object: mupdf.PDFObject,
    key: string,
    fallback: number,
  ): number {
    const value = object.getInheritable(key);
    try {
      const raw = value.valueOf();
      return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
    } finally {
      value.destroy();
    }
  }

  private constrainPageBoxes(pageObject: mupdf.PDFObject, crop: PdfRect): void {
    const constrain = (key: string, parent: PdfRect): PdfRect => {
      const existing = this.readRect(pageObject, key);
      if (existing === null) return parent;
      let result: PdfRect = [
        Math.max(parent[0], existing[0]),
        Math.max(parent[1], existing[1]),
        Math.min(parent[2], existing[2]),
        Math.min(parent[3], existing[3]),
      ];
      if (result[0] >= result[2] || result[1] >= result[3]) result = [...parent];
      this.putObjectValue(pageObject, key, result);
      return result;
    };
    const bleed = constrain("BleedBox", crop);
    constrain("TrimBox", bleed);
    constrain("ArtBox", bleed);
  }

  private putObjectValue(object: mupdf.PDFObject, key: string, value: unknown): void {
    const stored = object.put(key, value) as { destroy?: () => void } | undefined;
    stored?.destroy?.();
  }
}
