import type {
  PageEdit,
  PageInfo,
  RenderedPage,
  Rotation,
  TrimSensitivity,
  VisualRect,
} from "../types";
import type {
  PdfDocumentSnapshot,
  PdfWorkerOperation,
  PdfWorkerOperationOptions,
  PdfWorkerOutboundMessage,
  PdfWorkerRequest,
  PdfWorkerResultValue,
} from "./workerProtocol";

export type {
  PdfDocumentSnapshot,
  PdfWorkerOperation,
  PdfWorkerOperationOptions,
  PdfWorkerProgress,
} from "./workerProtocol";

interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<PdfWorkerOutboundMessage>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
}

export type PdfWorkerFactory = () => WorkerPort;

interface PendingRequest {
  operation: PdfWorkerOperation;
  resolve: (value: PdfWorkerResultValue) => void;
  reject: (reason: unknown) => void;
  onProgress?: PdfWorkerOperationOptions["onProgress"];
  removeAbortListener?: () => void;
  aborted?: boolean;
}

function defaultWorkerFactory(): WorkerPort {
  return new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The PDF operation was cancelled.", "AbortError");
  }
  const error = new Error("The PDF operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function errorFromWorker(error: {
  name: string;
  message: string;
  incorrectPassword?: boolean;
}): Error {
  const restored = new Error(error.message);
  restored.name = error.name;
  if (error.incorrectPassword !== undefined) {
    Object.defineProperty(restored, "incorrect", {
      configurable: true,
      enumerable: true,
      value: error.incorrectPassword,
    });
  }
  return restored;
}

function returnsDocument(
  operation: PdfWorkerOperation,
): operation is "open" | "append" | "reorganize" | "restore-snapshot" {
  return operation === "open" ||
    operation === "append" ||
    operation === "reorganize" ||
    operation === "restore-snapshot";
}

/**
 * Owns one dedicated PDF worker and any local documents opened inside it.
 * AbortSignal cancellation is cooperative; `terminate()` is the immediate
 * fallback for a stuck third-party parser and invalidates all document handles.
 */
export class PdfWorkerClient {
  private readonly worker: WorkerPort;
  private readonly pending = new Map<string, PendingRequest>();
  private terminated = false;

  constructor(
    workerFactory: PdfWorkerFactory = defaultWorkerFactory,
    private readonly onFatalError?: (error: Error) => void,
  ) {
    this.worker = workerFactory();
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  async open(
    bytes: Uint8Array,
    password?: string,
    options?: PdfWorkerOperationOptions,
  ): Promise<PdfWorkerDocument> {
    const transferredBytes = transferableCopy(bytes);
    const snapshot = await this.request(
      {
        type: "request",
        requestId: createRequestId(),
        operation: "open",
        payload: { bytes: transferredBytes, password },
      },
      options,
      [transferredBytes],
    ) as PdfDocumentSnapshot;
    return new PdfWorkerDocument(this, snapshot);
  }

  /** Immediately stops all work and releases every MuPDF document in this worker. */
  terminate(reason = "The local PDF worker was stopped."): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    const error = new Error(reason);
    error.name = "PdfWorkerTerminatedError";
    for (const pending of this.pending.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  requestDocument(
    operation: "append" | "reorganize" | "restore-snapshot",
    payload:
      | { documentId: string; sourceDocumentIds: string[] }
      | { documentId: string; pageOrder: number[] }
      | { documentId: string; bytes: ArrayBuffer },
    options?: PdfWorkerOperationOptions,
    transfer: Transferable[] = [],
  ): Promise<PdfWorkerDocument> {
    return this.request(
      {
        type: "request",
        requestId: createRequestId(),
        operation,
        payload,
      } as PdfWorkerRequest,
      options,
      transfer,
    ).then((value) => new PdfWorkerDocument(this, value as PdfDocumentSnapshot));
  }

  requestValue(
    request: Omit<PdfWorkerRequest, "requestId" | "type">,
    options?: PdfWorkerOperationOptions,
    transfer: Transferable[] = [],
  ): Promise<PdfWorkerResultValue> {
    return this.request(
      {
        ...request,
        type: "request",
        requestId: createRequestId(),
      } as PdfWorkerRequest,
      options,
      transfer,
    );
  }

  closeDocument(documentId: string): void {
    if (this.terminated) return;
    void this.requestValue({ operation: "close", payload: { documentId } }).catch(() => {
      // Closing is best-effort; termination remains available for hard cleanup.
    });
  }

  private request(
    request: PdfWorkerRequest,
    options?: PdfWorkerOperationOptions,
    transfer: Transferable[] = [],
  ): Promise<PdfWorkerResultValue> {
    if (this.terminated) {
      return Promise.reject(new Error("The local PDF worker has already been stopped."));
    }
    if (options?.signal?.aborted) return Promise.reject(abortError());

    return new Promise<PdfWorkerResultValue>((resolve, reject) => {
      const pending: PendingRequest = {
        operation: request.operation,
        resolve,
        reject,
        onProgress: options?.onProgress,
      };
      if (options?.signal) {
        const handleAbort = () => {
          const active = this.pending.get(request.requestId);
          if (!active) return;
          active.removeAbortListener?.();
          active.removeAbortListener = undefined;
          active.onProgress = undefined;
          active.aborted = true;
          try {
            this.worker.postMessage({ type: "cancel", requestId: request.requestId });
          } catch {
            // The original request may still finish. Its retained tombstone will
            // discard the result and release any late-created document.
          }
          reject(abortError());
        };
        options.signal.addEventListener("abort", handleAbort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener("abort", handleAbort);
      }
      this.pending.set(request.requestId, pending);
      try {
        this.worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(request.requestId);
        pending.removeAbortListener?.();
        reject(error);
      }
    });
  }

  private readonly handleMessage = (event: MessageEvent<PdfWorkerOutboundMessage>): void => {
    const message = event.data;
    if (message.type === "progress") {
      this.pending.get(message.progress.requestId)?.onProgress?.(message.progress);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    pending.removeAbortListener?.();
    if (pending.aborted) {
      if (message.type === "result" && returnsDocument(pending.operation)) {
        const snapshot = message.value as PdfDocumentSnapshot;
        this.closeDocument(snapshot.documentId);
      }
      return;
    }
    if (message.type === "result") pending.resolve(message.value);
    else pending.reject(errorFromWorker(message.error));
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    if (this.terminated) return;
    const error = new Error(event.message || "The local PDF worker failed.");
    error.name = "PdfWorkerError";
    this.terminated = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.onFatalError?.(error);
  };
}

/** Async, worker-backed counterpart to PdfEngine. */
export class PdfWorkerDocument {
  readonly pageInfos: PageInfo[];
  readonly byteLength: number;
  readonly encrypted: boolean;
  readonly requiresPassword: boolean;
  readonly canEdit: boolean;
  readonly canAssemble: boolean;
  readonly canCopy: boolean;

  private closed = false;

  constructor(
    private readonly client: PdfWorkerClient,
    private readonly snapshot: PdfDocumentSnapshot,
  ) {
    this.pageInfos = snapshot.pageInfos;
    this.byteLength = snapshot.byteLength;
    this.encrypted = snapshot.encrypted;
    this.requiresPassword = snapshot.requiresPassword;
    this.canEdit = snapshot.canEdit;
    this.canAssemble = snapshot.canAssemble;
    this.canCopy = snapshot.canCopy;
  }

  get documentId(): string {
    return this.snapshot.documentId;
  }

  async renderPage(
    pageIndex: number,
    editRotation: Rotation,
    scale: number,
    includeAnnotations = true,
    options?: PdfWorkerOperationOptions,
  ): Promise<RenderedPage> {
    this.assertOpen();
    return await this.client.requestValue(
      {
        operation: "render-page",
        payload: {
          documentId: this.documentId,
          pageIndex,
          editRotation,
          scale,
          includeAnnotations,
        },
      },
      options,
    ) as RenderedPage;
  }

  async autoTrim(
    pageIndex: number,
    editRotation: Rotation,
    sensitivity: TrimSensitivity,
    paddingPoints: number,
    includeAnnotations: boolean,
    options?: PdfWorkerOperationOptions,
  ): Promise<VisualRect | null> {
    this.assertOpen();
    return await this.client.requestValue(
      {
        operation: "auto-trim",
        payload: {
          documentId: this.documentId,
          pageIndex,
          editRotation,
          sensitivity,
          paddingPoints,
          includeAnnotations,
        },
      },
      options,
    ) as VisualRect | null;
  }

  async append(
    others: readonly PdfWorkerDocument[],
    options?: PdfWorkerOperationOptions,
  ): Promise<PdfWorkerDocument> {
    this.assertOpen();
    for (const other of others) {
      other.assertOpen();
      if (other.client !== this.client) {
        throw new Error("PDFs must be opened by the same worker client before they can be combined.");
      }
    }
    return await this.client.requestDocument(
      "append",
      {
        documentId: this.documentId,
        sourceDocumentIds: others.map((other) => other.documentId),
      },
      options,
    );
  }

  async reorganize(
    pageOrder: readonly number[],
    options?: PdfWorkerOperationOptions,
  ): Promise<PdfWorkerDocument> {
    this.assertOpen();
    return await this.client.requestDocument(
      "reorganize",
      { documentId: this.documentId, pageOrder: [...pageOrder] },
      options,
    );
  }

  async exportPdf(
    edits: PageEdit[],
    pageOrder?: readonly number[],
    options?: PdfWorkerOperationOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    this.assertOpen();
    return await this.client.requestValue(
      {
        operation: "export",
        payload: {
          documentId: this.documentId,
          edits,
          ...(pageOrder === undefined ? {} : { pageOrder: [...pageOrder] }),
        },
      },
      options,
    ) as Uint8Array<ArrayBuffer>;
  }

  async snapshotBytes(options?: PdfWorkerOperationOptions): Promise<Uint8Array<ArrayBuffer>> {
    this.assertOpen();
    return await this.client.requestValue(
      { operation: "snapshot", payload: { documentId: this.documentId } },
      options,
    ) as Uint8Array<ArrayBuffer>;
  }

  async restoreSnapshot(
    bytes: Uint8Array,
    options?: PdfWorkerOperationOptions,
  ): Promise<PdfWorkerDocument> {
    this.assertOpen();
    const transferredBytes = transferableCopy(bytes);
    return await this.client.requestDocument(
      "restore-snapshot",
      { documentId: this.documentId, bytes: transferredBytes },
      options,
      [transferredBytes],
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.closeDocument(this.documentId);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("This local PDF has already been closed.");
  }
}

/** Convenient type name for components migrated from the synchronous PdfEngine. */
export type AsyncPdfEngine = PdfWorkerDocument;
