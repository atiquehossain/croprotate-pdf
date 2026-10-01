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

const MAX_RENDER_DIMENSION = 3_200;
const MAX_RENDER_PIXELS = 5_000_000;
const MAX_USER_UNIT = 75_000;
const MAX_PAGE_COUNT = 1_000;

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
  readonly requiresPassword: boolean;
  readonly canEdit: boolean;
  readonly canAssemble: boolean;
  readonly canCopy: boolean;

  private readonly originalBytes: Uint8Array;
  private readonly password: string | null;
  private document: mupdf.PDFDocument;

  get byteLength(): number {
    return this.originalBytes.byteLength;
  }

  private constructor(
    document: mupdf.PDFDocument,
    bytes: Uint8Array,
    password: string | null,
    encrypted: boolean,
    requiresPassword: boolean,
  ) {
    this.document = document;
    this.originalBytes = new Uint8Array(bytes);
    this.password = password;
    this.encrypted = encrypted;
    this.requiresPassword = requiresPassword;
    this.canEdit = document.hasPermission("edit");
    this.canAssemble = document.hasPermission("assemble");
    this.canCopy = document.hasPermission("copy");
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
    const passwordRequired = document.needsPassword();
    if (passwordRequired && password === undefined) {
      document.destroy();
      throw new PasswordRequiredError(false);
    }
    let authentication = 1;
    if (password !== undefined) {
      authentication = document.authenticatePassword(password);
      if (!authentication) {
        document.destroy();
        throw new PasswordRequiredError(true);
      }
    } else if (!passwordRequired) {
      authentication = document.authenticatePassword("");
    }
    const encrypted = passwordRequired || authentication > 1;
    try {
      const pageCount = document.countPages();
      if (pageCount < 1) throw new Error("The PDF does not contain any pages.");
      if (pageCount > MAX_PAGE_COUNT) {
        throw new Error(`This PDF has more than the ${MAX_PAGE_COUNT.toLocaleString()}-page safety limit.`);
      }
      return new PdfEngine(
        document,
        bytes,
        encrypted ? password ?? "" : null,
        encrypted,
        passwordRequired,
      );
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
      const bounds = page.getBounds("CropBox");
      const pageWidth = Math.abs(bounds[2] - bounds[0]);
      const pageHeight = Math.abs(bounds[3] - bounds[1]);
      if (
        !Number.isFinite(pageWidth) ||
        !Number.isFinite(pageHeight) ||
        pageWidth <= 0 ||
        pageHeight <= 0 ||
        !Number.isFinite(scale) ||
        scale <= 0
      ) {
        throw new Error("This page has invalid dimensions and cannot be previewed safely.");
      }
      const dimensionLimit = MAX_RENDER_DIMENSION / Math.max(pageWidth, pageHeight);
      const areaLimit = Math.sqrt(MAX_RENDER_PIXELS / (pageWidth * pageHeight));
      const safeScale = Math.min(scale, dimensionLimit, areaLimit, 6);
      if (!Number.isFinite(safeScale) || safeScale <= 0) {
        throw new Error("This page is too large to preview safely.");
      }
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
          pixels: new Uint8ClampedArray(pixmap.getPixels()),
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
    const buffer = rendered.pixels.buffer;
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

  async append(others: readonly PdfEngine[]): Promise<PdfEngine> {
    if (!others.length) throw new Error("Choose at least one PDF to add.");
    if (!this.canAssemble) {
      throw new Error("The open PDF does not allow page assembly.");
    }
    if (others.some((engine) => !engine.canCopy)) {
      throw new Error("Every added PDF must allow content copying.");
    }
    if (others.some((engine) =>
      (engine.encrypted && !this.encrypted) ||
      (engine.requiresPassword && !this.requiresPassword)
    )) {
      throw new Error("Adding these pages would remove their encryption or required open password.");
    }
    const combinedPageCount = others.reduce(
      (total, engine) => total + engine.pageInfos.length,
      this.pageInfos.length,
    );
    if (combinedPageCount > MAX_PAGE_COUNT) {
      throw new Error(`The combined PDF would exceed the ${MAX_PAGE_COUNT.toLocaleString()}-page safety limit.`);
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
    const outputDocument = this.openOriginalDocument();
    let outputBuffer: mupdf.Buffer | null = null;
    let bytes: Uint8Array;
    try {
      for (const source of others) {
        const graftMap = outputDocument.newGraftMap();
        try {
          for (let index = 0; index < source.pageInfos.length; index += 1) {
            graftMap.graftPage(-1, source.document, index);
          }
        } finally {
          graftMap.destroy();
        }
      }
      outputBuffer = outputDocument.saveToBuffer(
        "garbage=2,compress,encrypt=keep",
      );
      bytes = outputBuffer.asUint8Array().slice();
    } finally {
      outputBuffer?.destroy();
      outputDocument.destroy();
    }
    return await this.openDerivedDocument(bytes);
  }

  async reorganize(pageOrder: readonly number[]): Promise<PdfEngine> {
    if (!this.canAssemble) throw new Error("This PDF does not allow page assembly.");
    this.validatePageOrder(pageOrder);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
    const outputDocument = this.openOriginalDocument();
    let outputBuffer: mupdf.Buffer | null = null;
    let bytes: Uint8Array;
    try {
      outputDocument.rearrangePages([...pageOrder]);
      outputBuffer = outputDocument.saveToBuffer(
        "garbage=2,compress,encrypt=keep",
      );
      bytes = outputBuffer.asUint8Array().slice();
    } finally {
      outputBuffer?.destroy();
      outputDocument.destroy();
    }
    return await this.openDerivedDocument(bytes);
  }

  async exportPdf(
    edits: PageEdit[],
    pageOrder?: readonly number[],
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.canEdit) throw new Error("This PDF does not allow editing.");
    if (pageOrder !== undefined && (!this.canAssemble || !this.canCopy)) {
      throw new Error("This PDF does not allow page extraction or assembly.");
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
    const outputDocument = this.openOriginalDocument();
    let outputBuffer: mupdf.Buffer | null = null;
    try {
      if (edits.length !== outputDocument.countPages()) {
        throw new Error("The page edit list no longer matches this PDF.");
      }
      if (pageOrder !== undefined) this.validatePageOrder(pageOrder);

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

      if (pageOrder !== undefined) outputDocument.rearrangePages([...pageOrder]);

      outputBuffer = outputDocument.saveToBuffer(
        "garbage=2,compress,encrypt=keep",
      );
      const bytes = outputBuffer.asUint8Array().slice();
      const verification = new mupdf.PDFDocument(bytes);
      try {
        const verificationRequiresPassword = verification.needsPassword();
        let verificationAuthentication = 1;
        if (verificationRequiresPassword) {
          verificationAuthentication = verification.authenticatePassword(this.password ?? "");
          if (!verificationAuthentication) {
            throw new Error("The generated encrypted PDF could not be reopened.");
          }
        } else {
          verificationAuthentication = verification.authenticatePassword(this.password ?? "");
        }
        const verificationEncrypted = verificationRequiresPassword || verificationAuthentication > 1;
        if (
          verificationEncrypted !== this.encrypted ||
          verificationRequiresPassword !== this.requiresPassword
        ) {
          throw new Error("The generated PDF did not retain the expected password protection.");
        }
        const expectedPageCount = pageOrder?.length ?? edits.length;
        if (verification.countPages() !== expectedPageCount) {
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

  private openOriginalDocument(): mupdf.PDFDocument {
    const document = new mupdf.PDFDocument(this.originalBytes);
    if (this.encrypted && !document.authenticatePassword(this.password ?? "")) {
      document.destroy();
      throw new Error("The PDF could not be authenticated for this operation.");
    }
    return document;
  }

  private async openDerivedDocument(bytes: Uint8Array): Promise<PdfEngine> {
    const derived = await PdfEngine.open(bytes, this.password ?? undefined);
    if (
      derived.encrypted !== this.encrypted ||
      derived.requiresPassword !== this.requiresPassword
    ) {
      derived.close();
      throw new Error("The rebuilt PDF did not retain the expected password protection.");
    }
    return derived;
  }

  private validatePageOrder(pageOrder: readonly number[]): void {
    if (!pageOrder.length) throw new Error("A PDF must contain at least one page.");
    const unique = new Set(pageOrder);
    if (unique.size !== pageOrder.length) {
      throw new Error("The same page cannot appear more than once.");
    }
    if (pageOrder.some((index) => !Number.isInteger(index) || index < 0 || index >= this.pageInfos.length)) {
      throw new Error("The page order contains an invalid page number.");
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
          const userUnit = Math.min(
            Math.max(this.readNumber(pageObject, "UserUnit", 1), 0.01),
            MAX_USER_UNIT,
          );
          const sourceWidthPoints = Math.abs(cropBox[2] - cropBox[0]) * userUnit;
          const sourceHeightPoints = Math.abs(cropBox[3] - cropBox[1]) * userUnit;
          if (
            !Number.isFinite(sourceWidthPoints) ||
            !Number.isFinite(sourceHeightPoints) ||
            sourceWidthPoints <= 0 ||
            sourceHeightPoints <= 0
          ) {
            throw new Error(`Page ${index + 1} has invalid dimensions.`);
          }
          infos.push({
            index,
            label: String(index + 1),
            originalRotation: normalizeRotation(rotationValue),
            rawCropBox: [...cropBox],
            rawMediaBox: [...mediaBox],
            userUnit,
            sourceWidthPoints,
            sourceHeightPoints,
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
