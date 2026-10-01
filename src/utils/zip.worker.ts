import { createStoredZip, type ZipEntry } from "./zip";

interface ZipWorkerRequest {
  entries: ZipEntry[];
}

type ZipWorkerResponse =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; bytes: Uint8Array<ArrayBuffer> }
  | { type: "error"; message: string };

self.onmessage = (event: MessageEvent<ZipWorkerRequest>) => {
  try {
    const bytes = createStoredZip(event.data.entries, ({ completed, total }) => {
      self.postMessage({ type: "progress", completed, total } satisfies ZipWorkerResponse);
    });
    self.postMessage(
      { type: "result", bytes } satisfies ZipWorkerResponse,
      { transfer: [bytes.buffer] },
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies ZipWorkerResponse);
  }
};

export {};
