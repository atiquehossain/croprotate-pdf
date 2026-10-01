import type { PdfEngine, PdfEngineProgress } from "./engine";
import {
  progressMessage,
  type PdfDocumentSnapshot,
  type PdfWorkerInboundMessage,
  type PdfWorkerOperation,
  type PdfWorkerOutboundMessage,
  type PdfWorkerRequest,
  type PdfWorkerResultValue,
} from "./workerProtocol";

const documents = new Map<string, PdfEngine>();
const controllers = new Map<string, AbortController>();
let requestQueue = Promise.resolve();
let fallbackDocumentId = 0;
let engineModulePromise: Promise<typeof import("./engine")> | null = null;

function loadEngineModule(): Promise<typeof import("./engine")> {
  // MuPDF initializes a sizeable WASM module with top-level await. Loading it
  // only after the message handler is installed prevents an early request from
  // being dispatched before `self.onmessage` exists in some embedded browsers.
  engineModulePromise ??= import("./engine");
  return engineModulePromise;
}

function createDocumentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackDocumentId += 1;
  return `pdf-${Date.now()}-${fallbackDocumentId}`;
}

function documentSnapshot(documentId: string, engine: PdfEngine): PdfDocumentSnapshot {
  return {
    documentId,
    pageInfos: engine.pageInfos,
    byteLength: engine.byteLength,
    encrypted: engine.encrypted,
    requiresPassword: engine.requiresPassword,
    canEdit: engine.canEdit,
    canAssemble: engine.canAssemble,
    canCopy: engine.canCopy,
  };
}

function requireDocument(documentId: string): PdfEngine {
  const engine = documents.get(documentId);
  if (!engine) throw new Error("This local PDF is no longer available. Please open it again.");
  return engine;
}

function post(message: PdfWorkerOutboundMessage, transfer: Transferable[] = []): void {
  // The transfer-list overload has broader worker support than the newer
  // StructuredSerializeOptions object form (notably in embedded browsers).
  (self as unknown as {
    postMessage(value: unknown, transfer: Transferable[]): void;
  }).postMessage(message, transfer);
}

function postProgress(
  requestId: string,
  operation: PdfWorkerOperation,
  progress: PdfEngineProgress,
): void {
  post({
    type: "progress",
    progress: {
      requestId,
      operation,
      ...progress,
      message: progressMessage(operation, progress.stage),
    },
  });
}

async function runRequest(
  request: PdfWorkerRequest,
  controller: AbortController,
): Promise<{ value: PdfWorkerResultValue; transfer?: Transferable[] }> {
  const options = {
    signal: controller.signal,
    onProgress: (progress: PdfEngineProgress) => {
      postProgress(request.requestId, request.operation, progress);
    },
  };

  switch (request.operation) {
    case "open": {
      postProgress(request.requestId, request.operation, {
        stage: "loading-engine",
        completed: 0,
        total: 1,
      });
      const { PdfEngine } = await loadEngineModule();
      const engine = await PdfEngine.open(
        new Uint8Array(request.payload.bytes),
        request.payload.password,
        options,
      );
      if (controller.signal.aborted) {
        engine.close();
        throw new DOMException("The PDF operation was cancelled.", "AbortError");
      }
      const documentId = createDocumentId();
      documents.set(documentId, engine);
      return { value: documentSnapshot(documentId, engine) };
    }
    case "render-page": {
      const {
        documentId,
        pageIndex,
        editRotation,
        scale,
        includeAnnotations,
      } = request.payload;
      const rendered = requireDocument(documentId).renderPage(
        pageIndex,
        editRotation,
        scale,
        includeAnnotations,
        options,
      );
      return { value: rendered, transfer: [rendered.pixels.buffer] };
    }
    case "auto-trim": {
      const {
        documentId,
        pageIndex,
        editRotation,
        sensitivity,
        paddingPoints,
        includeAnnotations,
      } = request.payload;
      const rect = await requireDocument(documentId).autoTrim(
        pageIndex,
        editRotation,
        sensitivity,
        paddingPoints,
        includeAnnotations,
        options,
      );
      return { value: rect };
    }
    case "append": {
      const destination = requireDocument(request.payload.documentId);
      const sources = request.payload.sourceDocumentIds.map(requireDocument);
      const combined = await destination.append(sources, options);
      if (controller.signal.aborted) {
        combined.close();
        throw new DOMException("The PDF operation was cancelled.", "AbortError");
      }
      const documentId = createDocumentId();
      documents.set(documentId, combined);
      return { value: documentSnapshot(documentId, combined) };
    }
    case "reorganize": {
      const reorganized = await requireDocument(request.payload.documentId).reorganize(
        request.payload.pageOrder,
        options,
      );
      if (controller.signal.aborted) {
        reorganized.close();
        throw new DOMException("The PDF operation was cancelled.", "AbortError");
      }
      const documentId = createDocumentId();
      documents.set(documentId, reorganized);
      return { value: documentSnapshot(documentId, reorganized) };
    }
    case "export": {
      const bytes = await requireDocument(request.payload.documentId).exportPdf(
        request.payload.edits,
        request.payload.pageOrder,
        options,
      );
      return { value: bytes, transfer: [bytes.buffer] };
    }
    case "snapshot": {
      postProgress(request.requestId, request.operation, {
        stage: "snapshotting",
        completed: 0,
        total: 1,
      });
      const bytes = requireDocument(request.payload.documentId).snapshotBytes();
      if (controller.signal.aborted) {
        throw new DOMException("The PDF operation was cancelled.", "AbortError");
      }
      postProgress(request.requestId, request.operation, {
        stage: "ready",
        completed: 1,
        total: 1,
      });
      return { value: bytes, transfer: [bytes.buffer] };
    }
    case "restore-snapshot": {
      const restored = await requireDocument(request.payload.documentId).restoreSnapshot(
        new Uint8Array(request.payload.bytes),
        options,
      );
      if (controller.signal.aborted) {
        restored.close();
        throw new DOMException("The PDF operation was cancelled.", "AbortError");
      }
      const documentId = createDocumentId();
      documents.set(documentId, restored);
      return { value: documentSnapshot(documentId, restored) };
    }
    case "close": {
      postProgress(request.requestId, request.operation, {
        stage: "closing",
        completed: 0,
        total: 1,
      });
      const engine = documents.get(request.payload.documentId);
      if (engine) {
        documents.delete(request.payload.documentId);
        engine.close();
      }
      postProgress(request.requestId, request.operation, {
        stage: "ready",
        completed: 1,
        total: 1,
      });
      return { value: null };
    }
  }
}

async function handleRequest(request: PdfWorkerRequest, controller: AbortController): Promise<void> {
  try {
    if (controller.signal.aborted) {
      throw new DOMException("The PDF operation was cancelled.", "AbortError");
    }
    const result = await runRequest(request, controller);
    if (controller.signal.aborted) {
      throw new DOMException("The PDF operation was cancelled.", "AbortError");
    }
    post(
      {
        type: "result",
        requestId: request.requestId,
        operation: request.operation,
        value: result.value,
      },
      result.transfer,
    );
  } catch (error) {
    post({
      type: "error",
      requestId: request.requestId,
      operation: request.operation,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.name === "PasswordRequiredError"
          ? { incorrectPassword: Boolean((error as Error & { incorrect?: boolean }).incorrect) }
          : {}),
      },
    });
  } finally {
    controllers.delete(request.requestId);
  }
}

self.onmessage = (event: MessageEvent<PdfWorkerInboundMessage>) => {
  const message = event.data;
  if (message.type === "cancel") {
    controllers.get(message.requestId)?.abort();
    return;
  }

  const controller = new AbortController();
  controllers.set(message.requestId, controller);
  requestQueue = requestQueue.then(
    () => handleRequest(message, controller),
    () => handleRequest(message, controller),
  );
};

export {};
