import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoredZipInWorker } from "./zipClient";

class ThrowingWorker {
  static latest: ThrowingWorker | null = null;
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    ThrowingWorker.latest = this;
  }

  postMessage(): void {
    throw new DOMException("The buffer could not be cloned.", "DataCloneError");
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("createStoredZipInWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    ThrowingWorker.latest = null;
  });

  it("terminates the worker when the initial postMessage throws", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);

    await expect(createStoredZipInWorker([
      { name: "one.pdf", data: new Uint8Array([1, 2, 3]) },
    ])).rejects.toMatchObject({ name: "DataCloneError" });
    expect(ThrowingWorker.latest?.terminated).toBe(true);
  });
});
