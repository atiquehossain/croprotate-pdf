import type {
  PageEdit,
  PageInfo,
  RenderedPage,
  Rotation,
  TrimSensitivity,
  VisualRect,
} from "../types";
import type { Annotation } from "../annotations/types";

export type PdfWorkerOperation =
  | "open"
  | "render-page"
  | "auto-trim"
  | "append"
  | "reorganize"
  | "export"
  | "snapshot"
  | "restore-snapshot"
  | "close";

export interface PdfDocumentSnapshot {
  documentId: string;
  pageInfos: PageInfo[];
  byteLength: number;
  encrypted: boolean;
  requiresPassword: boolean;
  canEdit: boolean;
  canAssemble: boolean;
  canCopy: boolean;
}

export interface PdfWorkerProgress {
  requestId: string;
  operation: PdfWorkerOperation;
  stage: string;
  completed: number;
  total: number;
  message: string;
}

export interface PdfWorkerOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PdfWorkerProgress) => void;
}

export interface PdfExportOptions extends PdfWorkerOperationOptions {
  /** Current-source-page-indexed annotation arrays. Data stays in the worker. */
  annotations?: readonly (readonly Annotation[])[];
}

export type PdfWorkerRequest =
  | {
      type: "request";
      requestId: string;
      operation: "open";
      payload: { bytes: ArrayBuffer; password?: string };
    }
  | {
      type: "request";
      requestId: string;
      operation: "render-page";
      payload: {
        documentId: string;
        pageIndex: number;
        editRotation: Rotation;
        scale: number;
        includeAnnotations: boolean;
      };
    }
  | {
      type: "request";
      requestId: string;
      operation: "auto-trim";
      payload: {
        documentId: string;
        pageIndex: number;
        editRotation: Rotation;
        sensitivity: TrimSensitivity;
        paddingPoints: number;
        includeAnnotations: boolean;
      };
    }
  | {
      type: "request";
      requestId: string;
      operation: "append";
      payload: { documentId: string; sourceDocumentIds: string[] };
    }
  | {
      type: "request";
      requestId: string;
      operation: "reorganize";
      payload: { documentId: string; pageOrder: number[] };
    }
  | {
      type: "request";
      requestId: string;
      operation: "export";
      payload: {
        documentId: string;
        edits: PageEdit[];
        pageOrder?: number[];
        annotations?: readonly (readonly Annotation[])[];
      };
    }
  | {
      type: "request";
      requestId: string;
      operation: "snapshot";
      payload: { documentId: string };
    }
  | {
      type: "request";
      requestId: string;
      operation: "restore-snapshot";
      payload: { documentId: string; bytes: ArrayBuffer };
    }
  | {
      type: "request";
      requestId: string;
      operation: "close";
      payload: { documentId: string };
    };

export interface PdfWorkerCancelRequest {
  type: "cancel";
  requestId: string;
}

export type PdfWorkerInboundMessage = PdfWorkerRequest | PdfWorkerCancelRequest;

export type PdfWorkerResultValue =
  | PdfDocumentSnapshot
  | RenderedPage
  | VisualRect
  | Uint8Array<ArrayBuffer>
  | null;

export type PdfWorkerOutboundMessage =
  | {
      type: "progress";
      progress: PdfWorkerProgress;
    }
  | {
      type: "result";
      requestId: string;
      operation: PdfWorkerOperation;
      value: PdfWorkerResultValue;
    }
  | {
      type: "error";
      requestId: string;
      operation: PdfWorkerOperation;
      error: {
        name: string;
        message: string;
        incorrectPassword?: boolean;
      };
    };

export function progressMessage(operation: PdfWorkerOperation, stage: string): string {
  const messages: Partial<Record<PdfWorkerOperation, Record<string, string>>> = {
    open: {
      "loading-engine": "Starting the private PDF engine…",
      opening: "Opening PDF locally…",
      ready: "PDF ready.",
    },
    "render-page": {
      rendering: "Rendering page preview…",
      ready: "Preview ready.",
    },
    "auto-trim": {
      rendering: "Rendering page for auto-trim…",
      analyzing: "Finding page content…",
      ready: "Auto-trim ready.",
    },
    append: {
      "copying-pages": "Adding pages locally…",
      saving: "Building combined PDF…",
      ready: "PDFs combined.",
    },
    reorganize: {
      reordering: "Reordering pages…",
      saving: "Building organized PDF…",
      ready: "Page order updated.",
    },
    export: {
      "applying-edits": "Applying page edits…",
      "flattening-annotations": "Flattening annotations privately…",
      saving: "Building your PDF…",
      ready: "PDF ready to download.",
    },
    snapshot: {
      snapshotting: "Saving a local undo point…",
      ready: "Undo point ready.",
    },
    "restore-snapshot": {
      restoring: "Restoring pages…",
      ready: "Pages restored.",
    },
    close: {
      closing: "Closing local PDF…",
      ready: "PDF closed.",
    },
  };
  return messages[operation]?.[stage] ?? "Processing PDF locally…";
}
