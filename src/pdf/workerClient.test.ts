import { describe, expect, it } from "vitest";
import { PdfWorkerClient } from "./workerClient";
import type {
  PdfDocumentSnapshot,
  PdfWorkerInboundMessage,
  PdfWorkerOutboundMessage,
} from "./workerProtocol";

class MockWorker {
  readonly sent: PdfWorkerInboundMessage[] = [];
  terminated = false;
  private messageListener: ((event: MessageEvent<PdfWorkerOutboundMessage>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: PdfWorkerInboundMessage): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<PdfWorkerOutboundMessage>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.messageListener = listener as (event: MessageEvent<PdfWorkerOutboundMessage>) => void;
    } else {
      this.errorListener = listener as (event: ErrorEvent) => void;
    }
  }

  emit(message: PdfWorkerOutboundMessage): void {
    this.messageListener?.({ data: message } as MessageEvent<PdfWorkerOutboundMessage>);
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent);
  }
}

function snapshot(documentId = "doc-1"): PdfDocumentSnapshot {
  return {
    documentId,
    pageInfos: [{
      index: 0,
      label: "1",
      originalRotation: 0,
      rawCropBox: [0, 0, 100, 200],
      rawMediaBox: [0, 0, 100, 200],
      userUnit: 1,
      sourceWidthPoints: 100,
      sourceHeightPoints: 200,
    }],
    byteLength: 42,
    encrypted: false,
    requiresPassword: false,
    canEdit: true,
    canAssemble: true,
    canCopy: true,
  };
}

function latestRequest(worker: MockWorker) {
  const request = [...worker.sent].reverse().find((message) => message.type === "request");
  if (!request || request.type !== "request") throw new Error("Expected a worker request.");
  return request;
}

describe("PdfWorkerClient", () => {
  it("opens a worker-backed document and forwards progress", async () => {
    const worker = new MockWorker();
    const client = new PdfWorkerClient(() => worker);
    const updates: string[] = [];
    const opening = client.open(new Uint8Array([1, 2, 3]), undefined, {
      onProgress: (progress) => updates.push(progress.message),
    });
    const request = latestRequest(worker);
    expect(request.operation).toBe("open");

    worker.emit({
      type: "progress",
      progress: {
        requestId: request.requestId,
        operation: "open",
        stage: "opening",
        completed: 0,
        total: 1,
        message: "Opening PDF locally…",
      },
    });
    worker.emit({
      type: "result",
      requestId: request.requestId,
      operation: "open",
      value: snapshot(),
    });

    const document = await opening;
    expect(document.pageInfos).toHaveLength(1);
    expect(document.byteLength).toBe(42);
    expect(updates).toEqual(["Opening PDF locally…"]);
    client.terminate();
  });

  it("delivers transferable render pixels asynchronously", async () => {
    const worker = new MockWorker();
    const client = new PdfWorkerClient(() => worker);
    const opening = client.open(new Uint8Array([1]));
    const openRequest = latestRequest(worker);
    worker.emit({
      type: "result",
      requestId: openRequest.requestId,
      operation: "open",
      value: snapshot(),
    });
    const document = await opening;

    const rendering = document.renderPage(0, 0, 1);
    const renderRequest = latestRequest(worker);
    expect(renderRequest.operation).toBe("render-page");
    worker.emit({
      type: "result",
      requestId: renderRequest.requestId,
      operation: "render-page",
      value: {
        width: 1,
        height: 1,
        pixels: new Uint8ClampedArray([10, 20, 30, 255]),
      },
    });
    await expect(rendering).resolves.toMatchObject({ width: 1, height: 1 });
    client.terminate();
  });

  it("uses AbortSignal to reject work and sends a cooperative cancel request", async () => {
    const worker = new MockWorker();
    const client = new PdfWorkerClient(() => worker);
    const opening = client.open(new Uint8Array([1]));
    const openRequest = latestRequest(worker);
    worker.emit({
      type: "result",
      requestId: openRequest.requestId,
      operation: "open",
      value: snapshot(),
    });
    const document = await opening;

    const controller = new AbortController();
    const exporting = document.exportPdf([{ rotation: 0, crop: null }], undefined, {
      signal: controller.signal,
    });
    const exportRequest = latestRequest(worker);
    controller.abort();

    await expect(exporting).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.sent).toContainEqual({ type: "cancel", requestId: exportRequest.requestId });
    client.terminate();
  });

  it("sends source-page annotations with an export request", async () => {
    const worker = new MockWorker();
    const client = new PdfWorkerClient(() => worker);
    const opening = client.open(new Uint8Array([1]));
    const openRequest = latestRequest(worker);
    worker.emit({
      type: "result",
      requestId: openRequest.requestId,
      operation: "open",
      value: snapshot(),
    });
    const document = await opening;
    const annotations = [[{
      id: "stroke-1",
      pageId: "page-1",
      kind: "ink" as const,
      tool: "signature" as const,
      color: "#111111",
      opacity: 1,
      width: 2,
      strokes: [[{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }]],
    }]];

    const exporting = document.exportPdf([{ rotation: 0, crop: null }], undefined, {
      annotations,
    });
    const exportRequest = latestRequest(worker);
    expect(exportRequest).toMatchObject({
      operation: "export",
      payload: { documentId: "doc-1", annotations },
    });
    worker.emit({
      type: "result",
      requestId: exportRequest.requestId,
      operation: "export",
      value: new Uint8Array([4, 2]),
    });
    await expect(exporting).resolves.toEqual(new Uint8Array([4, 2]));
    client.terminate();
  });

  it("releases a document that finishes after its request was cancelled", async () => {
    const worker = new MockWorker();
    const client = new PdfWorkerClient(() => worker);
    const controller = new AbortController();
    const opening = client.open(new Uint8Array([1]), undefined, {
      signal: controller.signal,
    });
    const openRequest = latestRequest(worker);

    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });

    worker.emit({
      type: "result",
      requestId: openRequest.requestId,
      operation: "open",
      value: snapshot("late-document"),
    });

    const closeRequest = latestRequest(worker);
    expect(closeRequest).toMatchObject({
      operation: "close",
      payload: { documentId: "late-document" },
    });
    client.terminate();
  });

  it("terminates a stuck worker and rejects every pending request", async () => {
    const worker = new MockWorker();
    const client = new PdfWorkerClient(() => worker);
    const opening = client.open(new Uint8Array([1]));
    client.terminate("Stopped for test.");
    await expect(opening).rejects.toMatchObject({
      name: "PdfWorkerTerminatedError",
      message: "Stopped for test.",
    });
    expect(worker.terminated).toBe(true);
  });

  it("invalidates the client after an unrecoverable worker error", async () => {
    const worker = new MockWorker();
    const fatalErrors: Error[] = [];
    const client = new PdfWorkerClient(
      () => worker,
      (error) => fatalErrors.push(error),
    );
    const opening = client.open(new Uint8Array([1]));
    worker.emitError("WASM worker crashed.");
    await expect(opening).rejects.toMatchObject({
      name: "PdfWorkerError",
      message: "WASM worker crashed.",
    });
    await expect(client.open(new Uint8Array([2]))).rejects.toThrow("already been stopped");
    expect(client.isTerminated).toBe(true);
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      name: "PdfWorkerError",
      message: "WASM worker crashed.",
    });
    worker.emitError("A duplicate worker error.");
    expect(fatalErrors).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });
});
