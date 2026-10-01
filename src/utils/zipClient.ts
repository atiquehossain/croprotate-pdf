import type { ZipEntry, ZipProgress } from "./zip";

interface ZipWorkerProgress {
  type: "progress";
  completed: number;
  total: number;
}

interface ZipWorkerResult {
  type: "result";
  bytes: Uint8Array<ArrayBuffer>;
}

interface ZipWorkerError {
  type: "error";
  message: string;
}

export interface ZipWorkerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ZipProgress) => void;
}

function abortError(): Error {
  return new DOMException("ZIP creation was cancelled.", "AbortError");
}

/** Packages already-exported PDFs without blocking the interface. */
export function createStoredZipInWorker(
  entries: readonly ZipEntry[],
  options: ZipWorkerOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const worker = new Worker(new URL("./zip.worker.ts", import.meta.url), { type: "module" });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      options.signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
    };
    const handleAbort = () => {
      cleanup();
      reject(abortError());
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    worker.onmessage = (event: MessageEvent<ZipWorkerProgress | ZipWorkerResult | ZipWorkerError>) => {
      if (event.data.type === "progress") {
        options.onProgress?.(event.data);
        return;
      }
      cleanup();
      if (event.data.type === "result") resolve(event.data.bytes);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "ZIP packaging failed."));
    };

    const transferableEntries = entries.map((entry) => ({ name: entry.name, data: entry.data }));
    try {
      worker.postMessage(
        { entries: transferableEntries },
        transferableEntries.map((entry) => entry.data.buffer),
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
