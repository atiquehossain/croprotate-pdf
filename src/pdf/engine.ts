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

export interface PdfEngineProgress {
  stage: string;
  completed: number;
  total: number;
}

/**
 * Optional operation hooks used by the worker host. Existing callers can omit
 * this argument, so the direct engine API remains backwards compatible.
 */
export interface PdfEngineOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PdfEngineProgress) => void;
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The PDF operation was cancelled.", "AbortError");
  }
  const error = new Error("The PDF operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function reportProgress(
  options: PdfEngineOperationOptions | undefined,
  stage: string,
  completed: number,
  total: number,
): void {
  options?.onProgress?.({ stage, completed, total });
}

async function yieldForCancellation(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  throwIfAborted(signal);
}

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

  /**
   * Returns a detached copy of the exact bytes backing this engine. This is
   * useful for bounded structural undo stacks without keeping extra MuPDF
   * documents alive. Password protection, if present, remains intact.
   */
  snapshotBytes(): Uint8Array<ArrayBuffer> {
    return this.originalBytes.slice();
  }

  /**
   * Reopens a previously captured snapshot with this engine's retained
   * password. Callers never need to keep a plaintext PDF password solely for
   * structural undo/redo. The protection level is verified before returning.
   */
  async restoreSnapshot(
    bytes: Uint8Array,
    options?: PdfEngineOperationOptions,
  ): Promise<PdfEngine> {
    throwIfAborted(options?.signal);
    reportProgress(options, "restoring", 0, 1);
    const restored = await this.openDerivedDocument(bytes, options);
    reportProgress(options, "ready", 1, 1);
    return restored;
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

  static async open(
    bytes: Uint8Array,
    password?: string,
    options?: PdfEngineOperationOptions,
  ): Promise<PdfEngine> {
    throwIfAborted(options?.signal);
    reportProgress(options, "opening", 0, 1);
    await yieldForCancellation(options?.signal);
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
      const engine = new PdfEngine(
        document,
        bytes,
        encrypted ? password ?? "" : null,
        encrypted,
        passwordRequired,
      );
      throwIfAborted(options?.signal);
      reportProgress(options, "ready", 1, 1);
      return engine;
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
    options?: PdfEngineOperationOptions,
  ): RenderedPage {
    throwIfAborted(options?.signal);
    reportProgress(options, "rendering", 0, 1);
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
        const rendered = {
          width: pixmap.getWidth(),
          height: pixmap.getHeight(),
          pixels: new Uint8ClampedArray(pixmap.getPixels()),
        };
        throwIfAborted(options?.signal);
        reportProgress(options, "ready", 1, 1);
        return rendered;
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
    options?: PdfEngineOperationOptions,
  ): Promise<VisualRect | null> {
    throwIfAborted(options?.signal);
    reportProgress(options, "rendering", 0, 2);
    const info = this.pageInfos[pageIndex];
    const [pageWidth, pageHeight] = visualPageDimensions(
      info,
      totalRotation(info, editRotation),
    );
    const scale = Math.min(2, 1200 / Math.max(pageWidth, pageHeight));
    const rendered = this.renderPage(pageIndex, editRotation, scale, includeAnnotations, {
      signal: options?.signal,
    });
    const tolerance = {
      "Faint text": 7,
      Balanced: 14,
      "Clean scan": 24,
    }[sensitivity];
    const worker = new Worker(new URL("./autoTrim.worker.ts", import.meta.url), {
      type: "module",
    });
    const buffer = rendered.pixels.buffer;
    reportProgress(options, "analyzing", 1, 2);
    return new Promise<VisualRect | null>((resolve, reject) => {
      const handleAbort = () => {
        globalThis.clearTimeout(timeout);
        worker.terminate();
        reject(abortError());
      };
      const timeout = globalThis.setTimeout(() => {
        options?.signal?.removeEventListener("abort", handleAbort);
        worker.terminate();
        reject(new Error("Auto-trim took too long and was cancelled."));
      }, 30_000);
      options?.signal?.addEventListener("abort", handleAbort, { once: true });
      worker.onmessage = (
        event: MessageEvent<
          | { ok: true; rect: VisualRect | null }
          | { ok: false; error: string }
        >,
      ) => {
        globalThis.clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", handleAbort);
        worker.terminate();
        if (event.data.ok) {
          reportProgress(options, "ready", 2, 2);
          resolve(event.data.rect);
        }
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        globalThis.clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", handleAbort);
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

  async append(
    others: readonly PdfEngine[],
    options?: PdfEngineOperationOptions,
  ): Promise<PdfEngine> {
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
    throwIfAborted(options?.signal);
    const totalPagesToGraft = others.reduce((total, engine) => total + engine.pageInfos.length, 0);
    reportProgress(options, "copying-pages", 0, totalPagesToGraft + 1);
    await yieldForCancellation(options?.signal);
    const outputDocument = this.openOriginalDocument();
    let outputBuffer: mupdf.Buffer | null = null;
    let bytes: Uint8Array;
    try {
      let completedPages = 0;
      for (const source of others) {
        const graftMap = outputDocument.newGraftMap();
        try {
          for (let index = 0; index < source.pageInfos.length; index += 1) {
            throwIfAborted(options?.signal);
            graftMap.graftPage(-1, source.document, index);
            completedPages += 1;
            reportProgress(options, "copying-pages", completedPages, totalPagesToGraft + 1);
            await yieldForCancellation(options?.signal);
          }
        } finally {
          graftMap.destroy();
        }
      }
      throwIfAborted(options?.signal);
      reportProgress(options, "saving", totalPagesToGraft, totalPagesToGraft + 1);
      outputBuffer = outputDocument.saveToBuffer(
        "garbage=2,compress,encrypt=keep",
      );
      bytes = outputBuffer.asUint8Array().slice();
      throwIfAborted(options?.signal);
    } finally {
      outputBuffer?.destroy();
      outputDocument.destroy();
    }
    const derived = await this.openDerivedDocument(bytes, options);
    reportProgress(options, "ready", totalPagesToGraft + 1, totalPagesToGraft + 1);
    return derived;
  }

  async reorganize(
    pageOrder: readonly number[],
    options?: PdfEngineOperationOptions,
  ): Promise<PdfEngine> {
    if (!this.canAssemble) throw new Error("This PDF does not allow page assembly.");
    this.validatePageOrder(pageOrder);
    throwIfAborted(options?.signal);
    reportProgress(options, "reordering", 0, 2);
    await yieldForCancellation(options?.signal);
    const outputDocument = this.openOriginalDocument();
    let outputBuffer: mupdf.Buffer | null = null;
    let bytes: Uint8Array;
    try {
      const materializedOrder = this.materializeDuplicatePages(outputDocument, pageOrder);
      outputDocument.rearrangePages(materializedOrder);
      throwIfAborted(options?.signal);
      reportProgress(options, "saving", 1, 2);
      outputBuffer = outputDocument.saveToBuffer(
        "garbage=2,compress,encrypt=keep",
      );
      bytes = outputBuffer.asUint8Array().slice();
    } finally {
      outputBuffer?.destroy();
      outputDocument.destroy();
    }
    const derived = await this.openDerivedDocument(bytes, options);
    reportProgress(options, "ready", 2, 2);
    return derived;
  }

  async exportPdf(
    edits: PageEdit[],
    pageOrder?: readonly number[],
    options?: PdfEngineOperationOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.canEdit) throw new Error("This PDF does not allow editing.");
    if (pageOrder !== undefined && (!this.canAssemble || !this.canCopy)) {
      throw new Error("This PDF does not allow page extraction or assembly.");
    }
    throwIfAborted(options?.signal);
    const pagesToEdit = pageOrder?.length ?? edits.length;
    const totalSteps = pagesToEdit + 2;
    reportProgress(options, "applying-edits", 0, totalSteps);
    await yieldForCancellation(options?.signal);
    const outputDocument = this.openOriginalDocument();
    let outputBuffer: mupdf.Buffer | null = null;
    try {
      if (edits.length !== outputDocument.countPages()) {
        throw new Error("The page edit list no longer matches this PDF.");
      }
      if (pageOrder !== undefined) this.validatePageOrder(pageOrder);

      // Ordered exports are the hot path for extraction and splitting. Arrange
      // the requested pages first so each output only pays to apply edits to
      // the pages it will contain. Mapping through pageOrder is important here:
      // repeated source indexes must receive the same source edit on every
      // materialized output page.
      if (pageOrder !== undefined) {
        const materializedOrder = this.materializeDuplicatePages(outputDocument, pageOrder);
        outputDocument.rearrangePages(materializedOrder);
      }

      for (let outputIndex = 0; outputIndex < pagesToEdit; outputIndex += 1) {
        throwIfAborted(options?.signal);
        const sourceIndex = pageOrder?.[outputIndex] ?? outputIndex;
        const edit = edits[sourceIndex];
        const info = this.pageInfos[sourceIndex];
        const page = outputDocument.loadPage(outputIndex);
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
        reportProgress(options, "applying-edits", outputIndex + 1, totalSteps);
        await yieldForCancellation(options?.signal);
      }

      throwIfAborted(options?.signal);
      reportProgress(options, "saving", pagesToEdit + 1, totalSteps);
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
      throwIfAborted(options?.signal);
      reportProgress(options, "ready", totalSteps, totalSteps);
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

  private async openDerivedDocument(
    bytes: Uint8Array,
    options?: PdfEngineOperationOptions,
  ): Promise<PdfEngine> {
    const derived = await PdfEngine.open(bytes, this.password ?? undefined, {
      signal: options?.signal,
    });
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
    if (pageOrder.length > MAX_PAGE_COUNT) {
      throw new Error(`The organized PDF would exceed the ${MAX_PAGE_COUNT.toLocaleString()}-page safety limit.`);
    }
    if (pageOrder.some((index) => !Number.isInteger(index) || index < 0 || index >= this.pageInfos.length)) {
      throw new Error("The page order contains an invalid page number.");
    }
  }

  /**
   * MuPDF's rearrangePages expects unique source indexes. Materialize later
   * occurrences first so a page-order array can also express duplication.
   */
  private materializeDuplicatePages(
    document: mupdf.PDFDocument,
    pageOrder: readonly number[],
  ): number[] {
    const used = new Set<number>();
    const materialized: number[] = [];
    let graftMap: mupdf.PDFGraftMap | null = null;
    try {
      for (const pageIndex of pageOrder) {
        if (!used.has(pageIndex)) {
          used.add(pageIndex);
          materialized.push(pageIndex);
          continue;
        }
        graftMap ??= document.newGraftMap();
        graftMap.graftPage(-1, document, pageIndex);
        materialized.push(document.countPages() - 1);
      }
      return materialized;
    } finally {
      graftMap?.destroy();
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
