import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleStop,
  Download,
  FileText,
  Files,
  FolderOpen,
  Github,
  MonitorDown,
  Redo2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Undo2,
  UploadCloud,
  WifiOff,
  X,
} from "lucide-react";
import type {
  AspectPreset,
  CropCopyMode,
  PageEdit,
  Rotation,
  TrimSensitivity,
  VisualRect,
} from "./types";
import type {
  PdfWorkerClient,
  PdfWorkerDocument,
  PdfWorkerOperationOptions,
  PdfWorkerProgress,
} from "./pdf/workerClient";
import {
  aspectRatioForPreset,
  cropsEqual,
  fitRectToAspect,
  normalizeRotation,
  normalizedAspectRatio,
  parsePageSelection,
  pointMarginsToVisualRect,
  sourceCropToVisualRect,
  totalRotation,
  visualPageDimensions,
  visualRectToPointMargins,
  visualRectToSourceCrop,
} from "./pdf/geometry";
import { Inspector } from "./components/Inspector";
import { PageRail } from "./components/PageRail";
import { PageOrganizer } from "./components/PageOrganizer";
import { PdfViewport } from "./components/PdfViewport";
import { buildSplitPlan, type SplitRequest } from "./components/organizerTools";
import { pushBoundedHistory } from "./utils/boundedHistory";
import { bytesToWholeMebibytes, splitOutputLimitBytes } from "./utils/memoryLimits";
import { createStoredZipInWorker } from "./utils/zipClient";
import { usePwa } from "./pwa/usePwa";
import {
  addAnnotation,
  annotationsForPageOrder,
  canRedoAnnotations,
  canUndoAnnotations,
  cloneAnnotationDocument,
  commitAnnotationHistory,
  createAnnotationDocument,
  createAnnotationHistory,
  deleteAnnotations,
  duplicateAnnotations,
  duplicatePageAnnotations,
  findAnnotation,
  getPageAnnotations,
  redoAnnotationHistory,
  removeAnnotationPage,
  resetAnnotationHistory,
  undoAnnotationHistory,
  updateAnnotation,
  sourcePointToViewport,
  viewportPointToSource,
  type Annotation,
  type AnnotationDocument,
  type AnnotationHistory,
  type AnnotationPoint,
  type AnnotationRect,
  type AnnotationStyle,
  type AnnotationTool,
  type AnnotationViewportTransform,
} from "./annotations";
import {
  AnnotationToolbar,
  SignatureDialog,
  TextAnnotationDialog,
  type NewAnnotation,
  type SignatureDraft,
  type SignatureKind,
  type TextComposerTool,
  type TextComposerValue,
} from "./components/annotations";

type PdfEngine = PdfWorkerDocument;
type PdfEngineModule = typeof import("./pdf/workerClient");
type EditorMode = "crop" | "annotate";

interface OperationState {
  id: number;
  label: string;
  message: string;
  completed: number;
  total: number;
}

interface OperationHandle {
  id: number;
  controller: AbortController;
  options: PdfWorkerOperationOptions;
}

interface DocumentSnapshot {
  bytes: Uint8Array<ArrayBuffer>;
  edits: PageEdit[];
  annotations: AnnotationDocument;
  pageIds: string[];
  selectedPageIds: string[];
  activePageId: string;
  fileName: string;
  fileSize: number;
  dirty: boolean;
}

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
}

let pdfEngineModulePromise: Promise<PdfEngineModule> | null = null;
const MAX_INPUT_FILE_BYTES = 75 * 1024 * 1024;
const MAX_WORKING_INPUT_BYTES = 100 * 1024 * 1024;

function loadPdfEngine(): Promise<PdfEngineModule> {
  if (pdfEngineModulePromise === null) {
    pdfEngineModulePromise = import("./pdf/workerClient").catch((error: unknown) => {
      pdfEngineModulePromise = null;
      throw error;
    });
  }
  return pdfEngineModulePromise;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function shouldWarmPdfEngineOnIdle(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return connection?.saveData !== true && connection?.effectiveType === "4g";
}

interface PendingPassword {
  file: File;
  bytes: Uint8Array;
  message: string;
  ownerRequired: boolean;
  purpose: "open" | "append";
}

let fallbackPageId = 0;
let fallbackAnnotationId = 0;

function createPageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackPageId += 1;
  return `page-${Date.now()}-${fallbackPageId}`;
}

function createPageIds(count: number): string[] {
  return Array.from({ length: count }, createPageId);
}

function createAnnotationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackAnnotationId += 1;
  return `annotation-${Date.now()}-${fallbackAnnotationId}`;
}

const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
  color: "#111827",
  opacity: 1,
  width: 2,
};

const DEFAULT_HIGHLIGHT_STYLE: AnnotationStyle = {
  color: "#facc15",
  opacity: 0.35,
  width: 18,
};

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function viewportRectToSourceBounds(
  rect: AnnotationRect,
  transform: AnnotationViewportTransform,
): AnnotationRect {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((point) => viewportPointToSource(point, transform));
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function placementRect(
  sourcePoint: AnnotationPoint,
  widthPoints: number,
  heightPoints: number,
  transform: AnnotationViewportTransform,
  visibleWidthPoints: number,
  visibleHeightPoints: number,
): { viewport: AnnotationRect; source: AnnotationRect } {
  const anchor = sourcePointToViewport(sourcePoint, transform);
  const width = Math.min(0.9, widthPoints / Math.max(visibleWidthPoints, 1));
  const height = Math.min(0.9, heightPoints / Math.max(visibleHeightPoints, 1));
  const viewport: AnnotationRect = {
    x: clampUnit(anchor.x - width / 2),
    y: clampUnit(anchor.y - height / 2),
    width,
    height,
  };
  viewport.x = Math.min(viewport.x, 1 - viewport.width);
  viewport.y = Math.min(viewport.y, 1 - viewport.height);
  return { viewport, source: viewportRectToSourceBounds(viewport, transform) };
}

function combinedFileName(fileName: string): string {
  const baseName = fileName.replace(/\.pdf$/i, "").replace(/-combined$/i, "") || "document";
  return `${baseName}-combined.pdf`;
}

async function readPdfFile(file: File): Promise<Uint8Array<ArrayBuffer>> {
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    throw new Error(`${file.name} is not a PDF file.`);
  }
  if (file.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`${file.name} exceeds the 75 MB per-file safety limit.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
  if (!header.includes("%PDF-")) {
    throw new Error(`${file.name} does not have a valid PDF header.`);
  }
  return bytes;
}

function downloadPdfBytes(bytes: Uint8Array<ArrayBuffer>, fileName: string): void {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadZipBytes(bytes: Uint8Array<ArrayBuffer>, fileName: string): void {
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function cloneEdits(edits: PageEdit[]): PageEdit[] {
  return edits.map((edit) => ({
    rotation: edit.rotation,
    crop: edit.crop === null ? null : [...edit.crop],
  }));
}

function editsEqual(first: PageEdit[], second: PageEdit[]): boolean {
  return (
    first.length === second.length &&
    first.every(
      (edit, index) =>
        edit.rotation === second[index].rotation && cropsEqual(edit.crop, second[index].crop),
    )
  );
}

function inferSourceUrl(): string {
  const configured = import.meta.env.VITE_SOURCE_URL as string | undefined;
  if (configured) return configured;
  if (window.location.hostname.endsWith(".github.io")) {
    const owner = window.location.hostname.split(".")[0];
    const repository = window.location.pathname.split("/").filter(Boolean)[0] ?? `${owner}.github.io`;
    return `https://github.com/${owner}/${repository}`;
  }
  return "https://github.com/";
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function handleDialogKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  onClose: () => void,
  closeDisabled = false,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    if (!closeDisabled) onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((element) => element.offsetParent !== null);
  if (!focusable.length) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFileInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<PdfEngine | null>(null);
  const workerClientRef = useRef<PdfWorkerClient | null>(null);
  const workerClientPromiseRef = useRef<Promise<PdfWorkerClient> | null>(null);
  const mountedRef = useRef(true);
  const operationControllerRef = useRef<AbortController | null>(null);
  const operationSequenceRef = useRef(0);
  const approvedReloadRef = useRef(false);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const organizerButtonRef = useRef<HTMLButtonElement>(null);
  const organizerAddButtonRef = useRef<HTMLButtonElement>(null);
  const privacyButtonRef = useRef<HTMLButtonElement>(null);
  const privacyReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [edits, setEdits] = useState<PageEdit[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<PageEdit[][]>([]);
  const [redoStack, setRedoStack] = useState<PageEdit[][]>([]);
  const [structureUndoStack, setStructureUndoStack] = useState<DocumentSnapshot[]>([]);
  const [structureRedoStack, setStructureRedoStack] = useState<DocumentSnapshot[]>([]);
  const [annotationHistory, setAnnotationHistory] = useState<AnnotationHistory>(() =>
    createAnnotationHistory(createAnnotationDocument()),
  );
  const [editorMode, setEditorMode] = useState<EditorMode>("crop");
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("select");
  const [annotationStyles, setAnnotationStyles] = useState({
    standard: DEFAULT_ANNOTATION_STYLE,
    highlighter: DEFAULT_HIGHLIGHT_STYLE,
  });
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [signatureDrafts, setSignatureDrafts] = useState<Record<SignatureKind, SignatureDraft | null>>({
    signature: null,
    initial: null,
  });
  const [signatureDialogKind, setSignatureDialogKind] = useState<SignatureKind | null>(null);
  const [pendingSignaturePoint, setPendingSignaturePoint] = useState<AnnotationPoint | null>(null);
  const [textDialogRequest, setTextDialogRequest] = useState<{
    tool: TextComposerTool;
    point: AnnotationPoint;
  } | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>("Free");
  const [aspectLocked, setAspectLocked] = useState(false);
  const [status, setStatus] = useState("Open a PDF to begin.");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [pendingPassword, setPendingPassword] = useState<PendingPassword | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [showAbout, setShowAbout] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showOrganizer, setShowOrganizer] = useState(false);
  const pwa = usePwa();

  const pages = engine?.pageInfos ?? [];
  const currentPage = pages[pageIndex];
  const currentEdit = edits[pageIndex];
  const currentPageId = pageIds[pageIndex] ?? "";
  const currentAnnotations = useMemo(
    () => currentPageId ? getPageAnnotations(annotationHistory.present, currentPageId) : [],
    [annotationHistory.present, currentPageId],
  );
  const exportAnnotations = useMemo(
    () => annotationsForPageOrder(annotationHistory.present, pageIds),
    [annotationHistory.present, pageIds],
  );
  const selectedAnnotation = selectedAnnotationId
    ? findAnnotation(annotationHistory.present, selectedAnnotationId)
    : undefined;
  const activeAnnotationStyle: AnnotationStyle = annotationTool === "select" && selectedAnnotation
    ? {
        color: selectedAnnotation.color,
        opacity: selectedAnnotation.opacity,
        width: selectedAnnotation.width,
      }
    : annotationTool === "highlighter"
      ? annotationStyles.highlighter
      : annotationStyles.standard;
  const selectedPageIdSet = useMemo(() => new Set(selectedPageIds), [selectedPageIds]);
  const sourceUrl = useMemo(inferSourceUrl, []);
  const privacyUrl = `${import.meta.env.BASE_URL}privacy.html`;
  const licenseUrl = useMemo(
    () => sourceUrl === "https://github.com/"
      ? "https://www.gnu.org/licenses/agpl-3.0.html"
      : `${sourceUrl.replace(/\/$/, "")}/blob/main/LICENSE`,
    [sourceUrl],
  );
  const modalOpen = pendingPassword !== null || showAbout || showPrivacy || showOrganizer || signatureDialogKind !== null || textDialogRequest !== null;

  const handleFatalWorkerError = useCallback((failedClient: PdfWorkerClient, error: Error) => {
    if (workerClientRef.current !== failedClient) return;
    workerClientRef.current = null;
    workerClientPromiseRef.current = null;
    if (!mountedRef.current) return;

    const hadOpenDocument = engineRef.current !== null;
    const fatalOperationId = ++operationSequenceRef.current;
    operationControllerRef.current?.abort();
    operationControllerRef.current = null;
    engineRef.current?.close();
    engineRef.current = null;
    setEngine(null);
    setFileName("");
    setFileSize(0);
    setEdits([]);
    setPageIds([]);
    setSelectedPageIds([]);
    setUndoStack([]);
    setRedoStack([]);
    setStructureUndoStack([]);
    setStructureRedoStack([]);
    setAnnotationHistory(createAnnotationHistory(createAnnotationDocument()));
    setEditorMode("crop");
    setAnnotationTool("select");
    setSelectedAnnotationId(null);
    setSignatureDrafts({ signature: null, initial: null });
    setSignatureDialogKind(null);
    setPendingSignaturePoint(null);
    setTextDialogRequest(null);
    setPageIndex(0);
    setZoom(1);
    setAspectPreset("Free");
    setAspectLocked(false);
    setBusy(false);
    setOperation(null);
    setDirty(false);
    setDragActive(false);
    setPendingPassword(null);
    setPasswordValue("");
    setShowOrganizer(false);
    const fatalMessage = hadOpenDocument
      ? `The private PDF engine stopped unexpectedly, so the open in-memory PDF and unsaved edits were cleared. ` +
        `Your original file was not changed or uploaded. Please reopen it. Technical detail: ${error.message}`
      : `The private PDF engine stopped unexpectedly before a PDF was opened. Nothing was uploaded. ` +
        `Please try opening the PDF again. Technical detail: ${error.message}`;
    setStatus(fatalMessage);
    window.setTimeout(() => {
      if (
        mountedRef.current &&
        operationSequenceRef.current === fatalOperationId &&
        engineRef.current === null
      ) {
        setStatus(fatalMessage);
      }
    }, 0);
    window.requestAnimationFrame(() => openButtonRef.current?.focus());
  }, []);

  const getWorkerClient = useCallback(async (): Promise<PdfWorkerClient> => {
    if (workerClientRef.current && !workerClientRef.current.isTerminated) {
      return workerClientRef.current;
    }
    if (workerClientRef.current?.isTerminated) workerClientRef.current = null;
    if (workerClientPromiseRef.current) return workerClientPromiseRef.current;

    const pending = loadPdfEngine().then(({ PdfWorkerClient: WorkerClient }) => {
      if (workerClientRef.current && !workerClientRef.current.isTerminated) {
        return workerClientRef.current;
      }
      let client!: PdfWorkerClient;
      client = new WorkerClient(
        undefined,
        (error) => handleFatalWorkerError(client, error),
      );
      workerClientRef.current = client;
      return client;
    });
    workerClientPromiseRef.current = pending;
    void pending.then(
      () => {
        if (workerClientPromiseRef.current === pending) workerClientPromiseRef.current = null;
      },
      () => {
        if (workerClientPromiseRef.current === pending) workerClientPromiseRef.current = null;
      },
    );
    return pending;
  }, [handleFatalWorkerError]);

  const warmPdfWorker = useCallback(() => {
    void getWorkerClient().catch(() => {
      // Opening a PDF will retry and surface a useful error if warm-up failed.
      workerClientRef.current = null;
    });
  }, [getWorkerClient]);

  const beginOperation = useCallback((label: string): OperationHandle => {
    const id = ++operationSequenceRef.current;
    const controller = new AbortController();
    operationControllerRef.current = controller;
    setOperation({ id, label, message: label, completed: 0, total: 0 });
    const onProgress = (progress: PdfWorkerProgress) => {
      if (operationSequenceRef.current !== id) return;
      setOperation({
        id,
        label,
        message: progress.message,
        completed: progress.completed,
        total: progress.total,
      });
    };
    return { id, controller, options: { signal: controller.signal, onProgress } };
  }, []);

  const updateOperation = useCallback((handle: OperationHandle, message: string, completed = 0, total = 0) => {
    if (operationSequenceRef.current !== handle.id) return;
    setOperation({ id: handle.id, label: message, message, completed, total });
  }, []);

  const endOperation = useCallback((handle: OperationHandle) => {
    if (operationSequenceRef.current !== handle.id) return;
    operationControllerRef.current = null;
    setOperation(null);
  }, []);

  const cancelOperation = useCallback(() => {
    const controller = operationControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setOperation((current) => current ? { ...current, message: "Cancelling safely…" } : current);
    setStatus("Cancelling the local PDF operation…");
  }, []);

  const installApp = useCallback(async () => {
    const outcome = await pwa.install();
    if (outcome === "accepted") setStatus("CropRotate PDF was added to your device for quick, offline access.");
    else if (outcome === "dismissed") setStatus("Install dismissed. You can keep using the website normally.");
    else setStatus("Use your browser menu to install this app on your device.");
  }, [pwa]);

  const applyAppUpdate = useCallback(async () => {
    if (engine && !window.confirm(
      dirty
        ? "Applying this update reloads the app and discards the unsaved working session. Save your PDF first unless you are ready to continue. Apply now?"
        : "Applying this update reloads the app and closes the current PDF. Apply now?",
    )) return;
    const activated = await pwa.update();
    if (!activated) {
      setStatus("The app is already up to date.");
      return;
    }
    approvedReloadRef.current = true;
    setStatus("Applying the app update…");
    let reloaded = false;
    const reload = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", reload, { once: true });
    window.setTimeout(reload, 1_500);
  }, [dirty, engine, pwa]);

  const closePassword = useCallback(() => {
    if (busy) return;
    setPendingPassword(null);
    setPasswordValue("");
    setStatus(engine ? "Kept the current PDF open." : "Open a PDF to begin.");
    window.requestAnimationFrame(() => {
      if (showOrganizer) organizerAddButtonRef.current?.focus();
      else openButtonRef.current?.focus();
    });
  }, [busy, engine, showOrganizer]);

  const closeAbout = useCallback(() => {
    setShowAbout(false);
    window.requestAnimationFrame(() => brandButtonRef.current?.focus());
  }, []);

  const openPrivacy = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    privacyReturnFocusRef.current = event.currentTarget;
    setShowPrivacy(true);
  }, []);

  const closePrivacy = useCallback(() => {
    setShowPrivacy(false);
    window.requestAnimationFrame(() => {
      const returnTarget = privacyReturnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      else privacyButtonRef.current?.focus();
    });
  }, []);

  const openOrganizer = useCallback(() => {
    if (!engine || busy) return;
    setSelectedPageIds([]);
    setShowOrganizer(true);
  }, [busy, engine]);

  const closeOrganizer = useCallback(() => {
    if (busy) return;
    setSelectedPageIds([]);
    setShowOrganizer(false);
    window.requestAnimationFrame(() => organizerButtonRef.current?.focus());
  }, [busy]);

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  useEffect(() => {
    setSelectedAnnotationId(null);
  }, [pageIndex]);

  useEffect(() => {
    if (!shouldWarmPdfEngineOnIdle()) return;

    const idleWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const idleHandle = idleWindow.requestIdleCallback?.(warmPdfWorker, { timeout: 3_000 });
    if (idleHandle !== undefined) {
      return () => idleWindow.cancelIdleCallback?.(idleHandle);
    }

    const timeoutHandle = window.setTimeout(warmPdfWorker, 1_500);
    return () => window.clearTimeout(timeoutHandle);
  }, [warmPdfWorker]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationControllerRef.current?.abort();
      workerClientRef.current?.terminate("The browser tab was closed.");
      void workerClientPromiseRef.current?.then(
        (client) => {
          if (!mountedRef.current) client.terminate("The browser tab was closed.");
        },
        () => undefined,
      );
    };
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty || approvedReloadRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [modalOpen]);

  const commitEdits = useCallback(
    (next: PageEdit[], message: string) => {
      if (editsEqual(edits, next)) {
        setStatus("Nothing changed.");
        return;
      }
      setUndoStack((history) => [...history, cloneEdits(edits)].slice(-100));
      setRedoStack([]);
      setEdits(cloneEdits(next));
      setDirty(true);
      setStatus(message);
    },
    [edits],
  );

  const undo = useCallback(() => {
    const previous = undoStack.at(-1);
    if (!previous || busy) return;
    setUndoStack((history) => history.slice(0, -1));
    setRedoStack((history) => [...history, cloneEdits(edits)].slice(-100));
    setEdits(cloneEdits(previous));
    setDirty(true);
    setStatus("Undid the last edit.");
  }, [busy, edits, undoStack]);

  const redo = useCallback(() => {
    const next = redoStack.at(-1);
    if (!next || busy) return;
    setRedoStack((history) => history.slice(0, -1));
    setUndoStack((history) => [...history, cloneEdits(edits)].slice(-100));
    setEdits(cloneEdits(next));
    setDirty(true);
    setStatus("Redid the last edit.");
  }, [busy, edits, redoStack]);

  const commitAnnotations = useCallback((
    next: AnnotationDocument,
    message: string,
    nextSelection: string | null = selectedAnnotationId,
  ) => {
    if (next === annotationHistory.present) {
      setStatus("Nothing changed.");
      return;
    }
    setAnnotationHistory(commitAnnotationHistory(annotationHistory, next));
    setSelectedAnnotationId(nextSelection);
    setDirty(true);
    setStatus(message);
  }, [annotationHistory, selectedAnnotationId]);

  const undoAnnotationChange = useCallback(() => {
    if (busy) return;
    const next = undoAnnotationHistory(annotationHistory);
    if (next === annotationHistory) return;
    setAnnotationHistory(next);
    setSelectedAnnotationId(null);
    setDirty(true);
    setStatus("Undid the last annotation change.");
  }, [annotationHistory, busy]);

  const redoAnnotationChange = useCallback(() => {
    if (busy) return;
    const next = redoAnnotationHistory(annotationHistory);
    if (next === annotationHistory) return;
    setAnnotationHistory(next);
    setSelectedAnnotationId(null);
    setDirty(true);
    setStatus("Redid the annotation change.");
  }, [annotationHistory, busy]);

  const deleteSelectedAnnotation = useCallback(() => {
    if (busy || !selectedAnnotationId) return;
    const selected = findAnnotation(annotationHistory.present, selectedAnnotationId);
    if (!selected) return;
    commitAnnotations(
      deleteAnnotations(annotationHistory.present, [selectedAnnotationId]),
      `Deleted ${selected.label ?? "the selected annotation"}.`,
      null,
    );
  }, [annotationHistory.present, busy, commitAnnotations, selectedAnnotationId]);

  const duplicateSelectedAnnotation = useCallback(() => {
    if (busy || !selectedAnnotationId || !currentPageId) return;
    const duplicateId = createAnnotationId();
    const next = duplicateAnnotations(
      annotationHistory.present,
      currentPageId,
      [selectedAnnotationId],
      () => duplicateId,
    );
    commitAnnotations(next, "Duplicated the selected annotation.", duplicateId);
  }, [annotationHistory.present, busy, commitAnnotations, currentPageId, selectedAnnotationId]);

  const captureDocumentSnapshot = useCallback(async (
    current: PdfEngine,
    handle: OperationHandle,
  ): Promise<DocumentSnapshot> => ({
    bytes: await current.snapshotBytes(handle.options),
    edits: cloneEdits(edits),
    annotations: cloneAnnotationDocument(annotationHistory.present),
    pageIds: [...pageIds],
    selectedPageIds: [...selectedPageIds],
    activePageId: pageIds[pageIndex] ?? pageIds[0] ?? "",
    fileName,
    fileSize,
    dirty,
  }), [annotationHistory.present, dirty, edits, fileName, fileSize, pageIds, pageIndex, selectedPageIds]);

  const installDocument = useCallback((opened: PdfEngine, file: File) => {
    const nextPageIds = createPageIds(opened.pageInfos.length);
    engineRef.current?.close();
    setEngine(opened);
    engineRef.current = opened;
    setFileName(file.name);
    setFileSize(file.size);
    setEdits(opened.pageInfos.map(() => ({ rotation: 0, crop: null })));
    setPageIds(nextPageIds);
    setSelectedPageIds([]);
    setUndoStack([]);
    setRedoStack([]);
    setStructureUndoStack([]);
    setStructureRedoStack([]);
    setAnnotationHistory(createAnnotationHistory(createAnnotationDocument(nextPageIds)));
    setEditorMode("crop");
    setAnnotationTool("select");
    setSelectedAnnotationId(null);
    setSignatureDrafts({ signature: null, initial: null });
    setSignatureDialogKind(null);
    setPendingSignaturePoint(null);
    setTextDialogRequest(null);
    setPageIndex(0);
    setZoom(1);
    setAspectPreset("Free");
    setAspectLocked(false);
    setDirty(false);
    setPendingPassword(null);
    setPasswordValue("");
    setStatus(`Loaded ${file.name} — ${opened.pageInfos.length} page${opened.pageInfos.length === 1 ? "" : "s"} locally. No document copy was uploaded or stored by the app.`);
  }, []);

  const installMergedDocument = useCallback((
    opened: PdfEngine,
    addedFiles: readonly File[],
    addedPageCount: number,
    addedEncryptedPdf: boolean,
    previousSnapshot: DocumentSnapshot,
  ) => {
    const addedPageIds = createPageIds(addedPageCount);
    const nextAnnotations = cloneAnnotationDocument(annotationHistory.present);
    for (const pageId of addedPageIds) nextAnnotations.pages[pageId] = [];
    const previous = engineRef.current;
    setEngine(opened);
    engineRef.current = opened;
    previous?.close();
    setEdits([
      ...cloneEdits(edits),
      ...Array.from({ length: addedPageCount }, () => ({ rotation: 0 as Rotation, crop: null })),
    ]);
    setPageIds([...pageIds, ...addedPageIds]);
    setUndoStack([]);
    setRedoStack([]);
    setStructureUndoStack((history) => pushBoundedHistory(history, previousSnapshot));
    setStructureRedoStack([]);
    setAnnotationHistory(resetAnnotationHistory(annotationHistory, nextAnnotations));
    setSelectedAnnotationId(null);
    setFileName(combinedFileName(fileName));
    setFileSize(opened.byteLength);
    setDirty(true);
    setPendingPassword(null);
    setPasswordValue("");
    const fileCount = addedFiles.length;
    const encryptionNote = addedEncryptedPdf
      ? " The combined copy uses the first PDF's password settings."
      : "";
    setStatus(`Added ${addedPageCount} page${addedPageCount === 1 ? "" : "s"} from ${fileCount} PDF${fileCount === 1 ? "" : "s"} locally. Existing page edits were kept, and this page change can be undone.${encryptionNote}`);
  }, [annotationHistory, edits, fileName, pageIds]);

  const openBytes = useCallback(
    async (
      file: File,
      bytes: Uint8Array,
      password?: string,
      ownerPasswordAttempt = false,
      activeOperation?: OperationHandle,
    ) => {
      const ownsOperation = activeOperation === undefined;
      const handle = activeOperation ?? beginOperation(`Opening ${file.name} locally…`);
      if (ownsOperation) setBusy(true);
      setStatus(`Opening ${file.name} locally…`);
      try {
        const client = await getWorkerClient();
        const opened = await client.open(bytes, password, handle.options);
        if (!opened.canEdit || !opened.canAssemble || !opened.canCopy) {
          opened.close();
          setPendingPassword({
            file,
            bytes,
            ownerRequired: true,
            purpose: "open",
            message: "That password opens the PDF, but editing, copying, or page assembly is restricted. Enter the owner password to use all tools.",
          });
          setPasswordValue("");
          setStatus("The owner password is required to use all editing and organizer tools.");
          return;
        }
        installDocument(opened, file);
        if (password !== undefined) {
          window.requestAnimationFrame(() => openButtonRef.current?.focus());
        }
      } catch (error) {
        if (isAbortError(error)) {
          setStatus(`Cancelled opening ${file.name}.${engineRef.current ? " The previous PDF is still open." : ""}`);
        } else if (error instanceof Error && error.name === "PasswordRequiredError") {
          setPendingPassword({
            file,
            bytes,
            ownerRequired: ownerPasswordAttempt,
            purpose: "open",
            message: ownerPasswordAttempt ? "That owner password did not unlock all editing permissions." : error.message,
          });
          setPasswordValue("");
          setStatus(ownerPasswordAttempt ? `The owner password is still required for ${file.name}.` : `Password required for ${file.name}.`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(`Could not open ${file.name}: ${message}${engineRef.current ? " The previous PDF is still open." : ""}`);
        }
      } finally {
        if (ownsOperation) {
          setBusy(false);
          endOperation(handle);
        }
      }
    },
    [beginOperation, endOperation, getWorkerClient, installDocument],
  );

  const acceptFile = useCallback(
    async (file: File) => {
      if (busy) {
        setStatus("Wait for the current PDF operation to finish.");
        return;
      }
      if (dirty && !window.confirm("Edits are not auto-saved. Open another PDF and discard the current unsaved edits?")) return;
      warmPdfWorker();
      setBusy(true);
      const handle = beginOperation(`Reading ${file.name} locally…`);
      setStatus(`Reading ${file.name} locally…`);
      try {
        const bytes = await readPdfFile(file);
        if (handle.controller.signal.aborted) throw new DOMException("The PDF operation was cancelled.", "AbortError");
        await openBytes(file, bytes, undefined, false, handle);
      } catch (error) {
        if (isAbortError(error)) {
          setStatus(`Cancelled opening ${file.name}.${engineRef.current ? " The previous PDF is still open." : ""}`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(`Could not open ${file.name}: ${message}${engineRef.current ? " The previous PDF is still open." : ""}`);
        }
      } finally {
        setBusy(false);
        endOperation(handle);
      }
    },
    [beginOperation, busy, dirty, endOperation, openBytes, warmPdfWorker],
  );

  const chooseFile = useCallback(() => {
    if (busy) {
      setStatus("Wait for the current PDF operation to finish.");
      return;
    }
    warmPdfWorker();
    fileInputRef.current?.click();
  }, [busy, warmPdfWorker]);

  const appendBytes = useCallback(
    async (
      file: File,
      bytes: Uint8Array,
      password?: string,
      ownerPasswordAttempt = false,
      activeOperation?: OperationHandle,
    ) => {
      const current = engineRef.current;
      if (!current) return;
      const ownsOperation = activeOperation === undefined;
      const handle = activeOperation ?? beginOperation(`Adding ${file.name} locally…`);
      if (ownsOperation) setBusy(true);
      setStatus(`Adding ${file.name} locally…`);
      let imported: PdfEngine | null = null;
      try {
        const client = await getWorkerClient();
        imported = await client.open(bytes, password, handle.options);
        if (!imported.canCopy) {
          imported.close();
          imported = null;
          setPendingPassword({
            file,
            bytes,
            ownerRequired: true,
            purpose: "append",
            message: "That password opens the PDF, but copying its pages is restricted. Enter the owner password to add it.",
          });
          setPasswordValue("");
          setStatus(`The owner password is required to add ${file.name}.`);
          return;
        }
        if (
          (imported.encrypted && !current.encrypted) ||
          (imported.requiresPassword && !current.requiresPassword)
        ) {
          setPendingPassword(null);
          setPasswordValue("");
          setStatus(`Could not add ${file.name}: the first PDF's settings would remove its encryption or required open password. Open the protected PDF first, then add other PDFs to it. The current PDF is unchanged.`);
          window.requestAnimationFrame(() => organizerAddButtonRef.current?.focus());
          return;
        }
        const addedPageCount = imported.pageInfos.length;
        const importedEncrypted = imported.encrypted;
        const previousSnapshot = await captureDocumentSnapshot(current, handle);
        const combined = await current.append([imported], handle.options);
        installMergedDocument(combined, [file], addedPageCount, importedEncrypted, previousSnapshot);
        if (password !== undefined) {
          window.requestAnimationFrame(() => organizerAddButtonRef.current?.focus());
        }
      } catch (error) {
        if (isAbortError(error)) {
          setStatus(`Cancelled adding ${file.name}. The current PDF is unchanged.`);
        } else if (error instanceof Error && error.name === "PasswordRequiredError") {
          setPendingPassword({
            file,
            bytes,
            ownerRequired: ownerPasswordAttempt,
            purpose: "append",
            message: ownerPasswordAttempt ? "That owner password did not allow copying these pages." : error.message,
          });
          setPasswordValue("");
          setStatus(ownerPasswordAttempt ? `The owner password is still required to add ${file.name}.` : `Password required to add ${file.name}.`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(`Could not add ${file.name}: ${message} The current PDF is unchanged.`);
        }
      } finally {
        imported?.close();
        if (ownsOperation) {
          setBusy(false);
          endOperation(handle);
        }
      }
    },
    [beginOperation, captureDocumentSnapshot, endOperation, getWorkerClient, installMergedDocument],
  );

  const acceptAddedFiles = useCallback(
    async (files: readonly File[]) => {
      const current = engineRef.current;
      if (!current || !files.length) return;
      if (busy) {
        setStatus("Wait for the current PDF operation to finish.");
        return;
      }
      const selectedBytes = files.reduce((total, file) => total + file.size, 0);
      if (current.byteLength + selectedBytes > MAX_WORKING_INPUT_BYTES) {
        setStatus("Could not add the selected PDFs: the working set would exceed the 100 MB in-memory safety limit. Add fewer or smaller files. The current PDF is unchanged.");
        return;
      }
      warmPdfWorker();
      setBusy(true);
      const handle = beginOperation(`Reading ${files.length} PDF${files.length === 1 ? "" : "s"} locally…`);
      setStatus(`Reading ${files.length} PDF${files.length === 1 ? "" : "s"} locally…`);
      if (files.length === 1) {
        try {
          const bytes = await readPdfFile(files[0]);
          if (handle.controller.signal.aborted) throw new DOMException("The PDF operation was cancelled.", "AbortError");
          await appendBytes(files[0], bytes, undefined, false, handle);
        } catch (error) {
          setStatus(isAbortError(error)
            ? `Cancelled adding ${files[0].name}. The current PDF is unchanged.`
            : `Could not add ${files[0].name}: ${error instanceof Error ? error.message : String(error)} The current PDF is unchanged.`);
        } finally {
          setBusy(false);
          endOperation(handle);
        }
        return;
      }

      const imported: PdfEngine[] = [];
      try {
        const client = await getWorkerClient();
        for (const [fileIndex, file] of files.entries()) {
          updateOperation(handle, `Reading ${file.name}…`, fileIndex, files.length + 2);
          const bytes = await readPdfFile(file);
          if (handle.controller.signal.aborted) throw new DOMException("The PDF operation was cancelled.", "AbortError");
          try {
            const opened = await client.open(bytes, undefined, handle.options);
            if (!opened.canCopy) {
              opened.close();
              throw new Error(`${file.name} does not allow content copying. Add it by itself and enter the owner password.`);
            }
            imported.push(opened);
          } catch (error) {
            if (error instanceof Error && error.name === "PasswordRequiredError") {
              throw new Error(`${file.name} needs a password. Add password-protected PDFs one at a time.`);
            }
            throw error;
          }
        }
        if (imported.some((item) =>
          (item.encrypted && !current.encrypted) ||
          (item.requiresPassword && !current.requiresPassword)
        )) {
          throw new Error("The first PDF's settings would remove another PDF's encryption or required open password. Open the protected PDF first, then add the other PDFs to it.");
        }
        const addedPageCount = imported.reduce((total, item) => total + item.pageInfos.length, 0);
        const previousSnapshot = await captureDocumentSnapshot(current, handle);
        const combined = await current.append(imported, handle.options);
        installMergedDocument(
          combined,
          files,
          addedPageCount,
          imported.some((item) => item.encrypted),
          previousSnapshot,
        );
      } catch (error) {
        setStatus(isAbortError(error)
          ? "Cancelled adding the selected PDFs. The current PDF is unchanged."
          : `Could not add the selected PDFs: ${error instanceof Error ? error.message : String(error)} The current PDF is unchanged.`);
      } finally {
        imported.forEach((item) => item.close());
        setBusy(false);
        endOperation(handle);
      }
    },
    [appendBytes, beginOperation, busy, captureDocumentSnapshot, endOperation, getWorkerClient, installMergedDocument, updateOperation, warmPdfWorker],
  );

  const chooseAddedFiles = useCallback(() => {
    if (busy || !engineRef.current) return;
    warmPdfWorker();
    addFileInputRef.current?.click();
  }, [busy, warmPdfWorker]);

  const cropCurrentPage = useCallback(
    (visualRect: VisualRect) => {
      if (!currentPage || !currentEdit || busy) return;
      try {
        const crop = visualRectToSourceCrop(
          visualRect,
          totalRotation(currentPage, currentEdit.rotation),
        );
        const next = cloneEdits(edits);
        next[pageIndex].crop = crop;
        commitEdits(next, `Updated the crop on page ${pageIndex + 1}.`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [busy, commitEdits, currentEdit, currentPage, edits, pageIndex],
  );

  const resetCrop = useCallback(() => {
    if (!currentEdit || currentEdit.crop === null || busy) return;
    const next = cloneEdits(edits);
    next[pageIndex].crop = null;
    commitEdits(next, `Reset the crop on page ${pageIndex + 1}.`);
  }, [busy, commitEdits, currentEdit, edits, pageIndex]);

  const rotateCurrent = useCallback(
    (amount: Rotation) => {
      if (!currentEdit || busy) return;
      const next = cloneEdits(edits);
      next[pageIndex].rotation = normalizeRotation(next[pageIndex].rotation + amount);
      commitEdits(next, `Rotated page ${pageIndex + 1}.`);
    },
    [busy, commitEdits, currentEdit, edits, pageIndex],
  );

  const resetRotation = useCallback(() => {
    if (!currentEdit || currentEdit.rotation === 0 || busy) return;
    const next = cloneEdits(edits);
    next[pageIndex].rotation = 0;
    commitEdits(next, `Reset the rotation on page ${pageIndex + 1}.`);
  }, [busy, commitEdits, currentEdit, edits, pageIndex]);

  const visualCrop = useMemo<VisualRect>(() => {
    if (!currentPage || !currentEdit) return [0, 0, 1, 1];
    return sourceCropToVisualRect(
      currentEdit.crop,
      totalRotation(currentPage, currentEdit.rotation),
    );
  }, [currentEdit, currentPage]);

  const currentDimensions = useMemo<[number, number]>(() => {
    if (!currentPage || !currentEdit) return [1, 1];
    return visualPageDimensions(currentPage, totalRotation(currentPage, currentEdit.rotation));
  }, [currentEdit, currentPage]);

  const annotationTransform = useMemo<AnnotationViewportTransform>(() => ({
    rotation: currentPage && currentEdit
      ? totalRotation(currentPage, currentEdit.rotation)
      : 0,
    crop: currentEdit?.crop ?? null,
    sourceWidthPoints: currentPage?.sourceWidthPoints ?? 1,
    sourceHeightPoints: currentPage?.sourceHeightPoints ?? 1,
  }), [currentEdit, currentPage]);

  const visibleAnnotationDimensions = useMemo<[number, number]>(() => [
    Math.max(1, currentDimensions[0] * (visualCrop[2] - visualCrop[0])),
    Math.max(1, currentDimensions[1] * (visualCrop[3] - visualCrop[1])),
  ], [currentDimensions, visualCrop]);

  const createPageAnnotation = useCallback((draft: NewAnnotation) => {
    if (busy || !currentPageId) return;
    const id = createAnnotationId();
    const annotation = { ...draft, id, pageId: currentPageId } as Annotation;
    try {
      commitAnnotations(
        addAnnotation(annotationHistory.present, annotation),
        `Added ${annotation.label?.toLowerCase() ?? "an annotation"}.`,
        id,
      );
      if (!["pen", "highlighter"].includes(annotationTool)) setAnnotationTool("select");
    } catch (error) {
      setStatus(`Could not add annotation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [annotationHistory.present, annotationTool, busy, commitAnnotations, currentPageId]);

  const changePageAnnotation = useCallback((annotation: Annotation) => {
    if (busy) return;
    try {
      commitAnnotations(
        updateAnnotation(annotationHistory.present, annotation.id, () => annotation),
        `Updated ${annotation.label?.toLowerCase() ?? "the annotation"}.`,
        annotation.id,
      );
    } catch (error) {
      setStatus(`Could not update annotation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [annotationHistory.present, busy, commitAnnotations]);

  const deletePageAnnotation = useCallback((annotationId: string) => {
    if (busy) return;
    const annotation = findAnnotation(annotationHistory.present, annotationId);
    if (!annotation) return;
    commitAnnotations(
      deleteAnnotations(annotationHistory.present, [annotationId]),
      `Deleted ${annotation.label?.toLowerCase() ?? "the annotation"}.`,
      selectedAnnotationId === annotationId ? null : selectedAnnotationId,
    );
  }, [annotationHistory.present, busy, commitAnnotations, selectedAnnotationId]);

  const changeAnnotationStyle = useCallback((style: AnnotationStyle) => {
    if (!selectedAnnotationId || annotationTool !== "select") {
      const bucket = annotationTool === "highlighter" ? "highlighter" : "standard";
      setAnnotationStyles((current) => ({ ...current, [bucket]: style }));
    }
    if (!selectedAnnotationId) return;
    const selected = findAnnotation(annotationHistory.present, selectedAnnotationId);
    if (!selected) return;
    try {
      commitAnnotations(
        updateAnnotation(annotationHistory.present, selectedAnnotationId, (annotation) => ({
          ...annotation,
          color: style.color,
          opacity: style.opacity,
          width: style.width,
        })),
        `Updated ${selected.label?.toLowerCase() ?? "the annotation"} appearance.`,
      );
    } catch (error) {
      setStatus(`Could not update appearance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [annotationHistory.present, annotationTool, commitAnnotations, selectedAnnotationId]);

  const placeTextAnnotation = useCallback((value: TextComposerValue) => {
    if (!textDialogRequest) return;
    const [visibleWidth, visibleHeight] = visibleAnnotationDimensions;
    const desiredWidth = Math.min(260, Math.max(110, value.text.length * value.fontSize * 0.58));
    const charactersPerLine = Math.max(1, Math.floor(desiredWidth / Math.max(value.fontSize * 0.58, 1)));
    const lineCount = value.text.split(/\r?\n/).reduce(
      (count, line) => count + Math.max(1, Math.ceil(line.length / charactersPerLine)),
      0,
    );
    const desiredHeight = Math.max(30, lineCount * value.fontSize * 1.35);
    const { source } = placementRect(
      textDialogRequest.point,
      desiredWidth,
      desiredHeight,
      annotationTransform,
      visibleWidth,
      visibleHeight,
    );
    createPageAnnotation({
      kind: "text",
      tool: textDialogRequest.tool,
      rect: source,
      text: value.text,
      fontSize: value.fontSize,
      fontFamily: value.fontFamily,
      align: value.align,
      ...activeAnnotationStyle,
      label: textDialogRequest.tool === "date" ? "Date" : "Text",
    });
    setTextDialogRequest(null);
  }, [activeAnnotationStyle, annotationTransform, createPageAnnotation, textDialogRequest, visibleAnnotationDimensions]);

  const createSignatureAnnotation = useCallback((
    draft: SignatureDraft,
    sourcePoint: AnnotationPoint,
  ) => {
    const [visibleWidth, visibleHeight] = visibleAnnotationDimensions;
    const widthPoints = draft.kind === "initial" ? 96 : 190;
    const heightPoints = draft.kind === "initial" ? 52 : 74;
    const placement = placementRect(
      sourcePoint,
      widthPoints,
      heightPoints,
      annotationTransform,
      visibleWidth,
      visibleHeight,
    );
    const label = draft.kind === "initial" ? "Visual initials" : "Visual signature";
    if (draft.input === "draw") {
      const strokes = draft.strokes.map((stroke) => stroke.map((point) => viewportPointToSource({
        x: placement.viewport.x + placement.viewport.width * (0.04 + point.x * 0.92),
        y: placement.viewport.y + placement.viewport.height * (0.04 + point.y * 0.92),
        pressure: point.pressure,
      }, annotationTransform)));
      createPageAnnotation({
        kind: "ink",
        tool: draft.kind,
        strokes,
        ...activeAnnotationStyle,
        width: Math.max(1.6, activeAnnotationStyle.width),
        label,
      });
    } else {
      createPageAnnotation({
        kind: "text",
        tool: draft.kind,
        rect: placement.source,
        text: draft.text,
        fontSize: draft.kind === "initial" ? 20 : 27,
        fontFamily: draft.fontFamily,
        align: "center",
        ...activeAnnotationStyle,
        label,
      });
    }
  }, [activeAnnotationStyle, annotationTransform, createPageAnnotation, visibleAnnotationDimensions]);

  const prepareSignature = useCallback((kind: SignatureKind) => {
    setAnnotationTool(kind);
    setSelectedAnnotationId(null);
    setPendingSignaturePoint(null);
    setSignatureDialogKind(kind);
  }, []);

  const requestSignaturePlacement = useCallback((kind: SignatureKind, point: AnnotationPoint) => {
    const draft = signatureDrafts[kind];
    if (draft) {
      createSignatureAnnotation(draft, point);
      return;
    }
    setPendingSignaturePoint(point);
    setSignatureDialogKind(kind);
  }, [createSignatureAnnotation, signatureDrafts]);

  const confirmSignatureDraft = useCallback((draft: SignatureDraft) => {
    setSignatureDrafts((current) => ({ ...current, [draft.kind]: draft }));
    setSignatureDialogKind(null);
    if (pendingSignaturePoint) {
      createSignatureAnnotation(draft, pendingSignaturePoint);
      setPendingSignaturePoint(null);
    } else {
      setAnnotationTool(draft.kind);
      setStatus(`Click the page to place your ${draft.kind === "initial" ? "initials" : "visual signature"}.`);
    }
  }, [createSignatureAnnotation, pendingSignaturePoint]);

  const aspectPhysical = useMemo(
    () => aspectRatioForPreset(aspectPreset, currentDimensions[0], currentDimensions[1]),
    [aspectPreset, currentDimensions],
  );
  const aspectNormalized =
    aspectLocked && aspectPhysical !== null
      ? normalizedAspectRatio(aspectPhysical, currentDimensions[0], currentDimensions[1])
      : null;

  const fitAspect = useCallback(() => {
    if (aspectPhysical === null) {
      setStatus("Choose an aspect ratio first.");
      return;
    }
    const ratio = normalizedAspectRatio(
      aspectPhysical,
      currentDimensions[0],
      currentDimensions[1],
    );
    cropCurrentPage(fitRectToAspect(visualCrop, ratio));
  }, [aspectPhysical, cropCurrentPage, currentDimensions, visualCrop]);

  const autoTrim = useCallback(
    async (
      sensitivity: TrimSensitivity,
      padding: number,
      includeAnnotations: boolean,
    ) => {
      if (!engine || !currentEdit || busy) return;
      const analyzedPage = pageIndex;
      const rotation = currentEdit.rotation;
      setBusy(true);
      const handle = beginOperation(`Analyzing page ${analyzedPage + 1} margins…`);
      setStatus(`Analyzing page ${analyzedPage + 1} margins…`);
      try {
        const result = await engine.autoTrim(
          analyzedPage,
          rotation,
          sensitivity,
          padding,
          includeAnnotations,
          handle.options,
        );
        if (result === null) {
          setStatus("Auto-trim found no safe removable border; crop unchanged.");
          return;
        }
        const crop = visualRectToSourceCrop(
          result,
          totalRotation(engine.pageInfos[analyzedPage], rotation),
        );
        const next = cloneEdits(edits);
        next[analyzedPage].crop = crop;
        commitEdits(next, `Auto-trimmed page ${analyzedPage + 1}.`);
      } catch (error) {
        setStatus(isAbortError(error)
          ? "Auto-trim cancelled; crop unchanged."
          : `Auto-trim failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
        endOperation(handle);
      }
    },
    [beginOperation, busy, commitEdits, currentEdit, edits, endOperation, engine, pageIndex],
  );

  const applyBatch = useCallback(
    ({
      pageSpecification,
      mode,
      applyCrop,
      applyRotation,
    }: {
      pageSpecification: string;
      mode: CropCopyMode;
      applyCrop: boolean;
      applyRotation: boolean;
    }) => {
      if (!engine || !currentPage || !currentEdit || busy) return;
      try {
        const targets = parsePageSelection(pageSpecification, pages.length);
        const next = cloneEdits(edits);
        const sourceVisual = sourceCropToVisualRect(
          currentEdit.crop,
          totalRotation(currentPage, currentEdit.rotation),
        );
        const sourceDimensions = visualPageDimensions(
          currentPage,
          totalRotation(currentPage, currentEdit.rotation),
        );
        const physicalMargins = visualRectToPointMargins(
          sourceVisual,
          sourceDimensions[0],
          sourceDimensions[1],
        );

        let skipped = 0;
        for (const target of targets) {
          const candidateRotation = applyRotation
            ? currentEdit.rotation
            : next[target].rotation;
          let candidateCrop = next[target].crop;

          if (applyCrop) {
            const targetPage = pages[target];
            const targetRotation = totalRotation(targetPage, candidateRotation);
            let targetVisual = sourceVisual;
            if (mode === "Same physical margins" && currentEdit.crop !== null) {
              const dimensions = visualPageDimensions(targetPage, targetRotation);
              targetVisual = pointMarginsToVisualRect(
                physicalMargins,
                dimensions[0],
                dimensions[1],
              );
              if (targetVisual[0] >= targetVisual[2] || targetVisual[1] >= targetVisual[3]) {
                skipped += 1;
                continue;
              }
            }
            candidateCrop =
              currentEdit.crop === null
                ? null
                : visualRectToSourceCrop(targetVisual, targetRotation);
          }

          if (applyRotation) next[target].rotation = candidateRotation;
          if (applyCrop) next[target].crop = candidateCrop;
        }
        const applied = targets.length - skipped;
        const summary = `Applied ${applyCrop && applyRotation ? "crop and rotation" : applyCrop ? "crop" : "rotation"} to ${applied} page${applied === 1 ? "" : "s"}.`;
        commitEdits(
          next,
          skipped ? `${summary} Skipped ${skipped} page${skipped === 1 ? "" : "s"} that were too small.` : summary,
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [busy, commitEdits, currentEdit, currentPage, edits, engine, pages],
  );

  const applyPageOrder = useCallback(
    async (
      pageOrder: number[],
      nextActivePageId: string,
      nextSelection: string[],
      message: string,
    ) => {
      const current = engineRef.current;
      if (!current || busy) return;
      setBusy(true);
      const handle = beginOperation("Rebuilding the page order locally…");
      setStatus("Rebuilding the page order locally…");
      try {
        const previousSnapshot = await captureDocumentSnapshot(current, handle);
        const reordered = await current.reorganize(pageOrder, handle.options);
        const nextEdits = pageOrder.map((index) => cloneEdits([edits[index]])[0]);
        const occurrences = new Map<number, number>();
        let nextAnnotations = cloneAnnotationDocument(annotationHistory.present);
        const nextPageIds = pageOrder.map((index) => {
          const occurrence = occurrences.get(index) ?? 0;
          occurrences.set(index, occurrence + 1);
          if (occurrence === 0) return pageIds[index];
          const duplicatedPageId = createPageId();
          nextAnnotations = duplicatePageAnnotations(
            nextAnnotations,
            pageIds[index],
            duplicatedPageId,
            () => createAnnotationId(),
          );
          return duplicatedPageId;
        });
        const retainedPageIds = new Set(nextPageIds);
        for (const existingPageId of Object.keys(nextAnnotations.pages)) {
          if (!retainedPageIds.has(existingPageId)) {
            nextAnnotations = removeAnnotationPage(nextAnnotations, existingPageId);
          }
        }
        setEngine(reordered);
        engineRef.current = reordered;
        current.close();
        setEdits(nextEdits);
        setPageIds(nextPageIds);
        setSelectedPageIds(nextSelection.filter((id) => nextPageIds.includes(id)));
        setPageIndex(Math.max(0, nextPageIds.indexOf(nextActivePageId)));
        setZoom(1);
        setUndoStack([]);
        setRedoStack([]);
        setAnnotationHistory(resetAnnotationHistory(annotationHistory, nextAnnotations));
        setSelectedAnnotationId(null);
        setStructureUndoStack((history) => pushBoundedHistory(history, previousSnapshot));
        setStructureRedoStack([]);
        setFileSize(reordered.byteLength);
        setDirty(true);
        setStatus(`${message} This page change can be undone.`);
      } catch (error) {
        setStatus(isAbortError(error)
          ? "Cancelled the page change. The current PDF is unchanged."
          : `Could not reorganize the pages: ${error instanceof Error ? error.message : String(error)} The current PDF is unchanged.`);
      } finally {
        setBusy(false);
        endOperation(handle);
      }
    },
    [annotationHistory, beginOperation, busy, captureDocumentSnapshot, edits, endOperation, pageIds],
  );

  const movePage = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0 || from >= pageIds.length || to >= pageIds.length) return;
      const order = pageIds.map((_, index) => index);
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      const activeId = pageIds[pageIndex];
      void applyPageOrder(
        order,
        activeId,
        selectedPageIds,
        `Moved page ${from + 1} to position ${to + 1}. Crop and rotation edits stayed with the page.`,
      );
    },
    [applyPageOrder, pageIds, pageIndex, selectedPageIds],
  );

  const moveSelectedPages = useCallback((selectedIds: readonly string[], insertionIndex: number) => {
    if (busy || selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    const selectedIndices = pageIds
      .map((pageId, index) => selected.has(pageId) ? index : -1)
      .filter((index) => index >= 0);
    const remainingIndices = pageIds
      .map((_, index) => index)
      .filter((index) => !selected.has(pageIds[index]));
    const slot = Math.max(0, Math.min(remainingIndices.length, insertionIndex));
    const order = [
      ...remainingIndices.slice(0, slot),
      ...selectedIndices,
      ...remainingIndices.slice(slot),
    ];
    const activeId = pageIds[pageIndex];
    void applyPageOrder(
      order,
      activeId,
      [...selectedIds],
      `Moved ${selectedIds.length} selected page${selectedIds.length === 1 ? "" : "s"} together.`,
    );
  }, [applyPageOrder, busy, pageIds, pageIndex]);

  const duplicateSelectedPages = useCallback((selectedIds: readonly string[]) => {
    if (busy || selectedIds.length === 0) return;
    if (pageIds.length + selectedIds.length > 1_000) {
      setStatus("Could not duplicate those pages because the working PDF would exceed the 1,000-page safety limit.");
      return;
    }
    const selected = new Set(selectedIds);
    const order: number[] = [];
    pageIds.forEach((pageId, index) => {
      order.push(index);
      if (selected.has(pageId)) order.push(index);
    });
    void applyPageOrder(
      order,
      pageIds[pageIndex],
      [...selectedIds],
      `Duplicated ${selectedIds.length} selected page${selectedIds.length === 1 ? "" : "s"}.`,
    );
  }, [applyPageOrder, busy, pageIds, pageIndex]);

  const restoreStructure = useCallback(async (direction: "undo" | "redo") => {
    const current = engineRef.current;
    const source = direction === "undo" ? structureUndoStack : structureRedoStack;
    const target = source.at(-1);
    if (!current || !target || busy) return;
    setBusy(true);
    const label = direction === "undo" ? "Undoing the last page change…" : "Redoing the page change…";
    const handle = beginOperation(label);
    setStatus(label);
    try {
      const present = await captureDocumentSnapshot(current, handle);
      const restored = await current.restoreSnapshot(target.bytes, handle.options);
      setEngine(restored);
      engineRef.current = restored;
      current.close();
      setEdits(cloneEdits(target.edits));
      setPageIds([...target.pageIds]);
      setSelectedPageIds(target.selectedPageIds.filter((id) => target.pageIds.includes(id)));
      const restoredIndex = target.pageIds.indexOf(target.activePageId);
      setPageIndex(restoredIndex >= 0 ? restoredIndex : 0);
      setZoom(1);
      setFileName(target.fileName);
      setFileSize(target.fileSize);
      setDirty(target.dirty);
      setUndoStack([]);
      setRedoStack([]);
      setAnnotationHistory(resetAnnotationHistory(annotationHistory, target.annotations));
      setSelectedAnnotationId(null);
      if (direction === "undo") {
        setStructureUndoStack((history) => history.slice(0, -1));
        setStructureRedoStack((history) => pushBoundedHistory(history, present));
      } else {
        setStructureRedoStack((history) => history.slice(0, -1));
        setStructureUndoStack((history) => pushBoundedHistory(history, present));
      }
      setStatus(`${direction === "undo" ? "Undid" : "Redid"} the page change. Crop and rotation values were restored with each page.`);
    } catch (error) {
      setStatus(isAbortError(error)
        ? `${direction === "undo" ? "Undo" : "Redo"} cancelled; the current PDF is unchanged.`
        : `Could not ${direction} the page change: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      endOperation(handle);
    }
  }, [annotationHistory, beginOperation, busy, captureDocumentSnapshot, endOperation, structureRedoStack, structureUndoStack]);

  const undoStructure = useCallback(() => void restoreStructure("undo"), [restoreStructure]);
  const redoStructure = useCallback(() => void restoreStructure("redo"), [restoreStructure]);

  const toggleSelectedPage = useCallback((pageId: string) => {
    setSelectedPageIds((current) =>
      current.includes(pageId)
        ? current.filter((id) => id !== pageId)
        : [...current, pageId],
    );
  }, []);

  const deleteSelectedPages = useCallback(() => {
    if (busy || !selectedPageIds.length || selectedPageIds.length >= pageIds.length) return;
    const selected = new Set(selectedPageIds);
    const count = selected.size;
    const positions = pageIds
      .map((id, index) => selected.has(id) ? index + 1 : -1)
      .filter((position) => position > 0);
    const shown = positions.slice(0, 8).join(", ");
    const pageList = positions.length > 8 ? `${shown}, and ${positions.length - 8} more` : shown;
    if (!window.confirm(`Remove page${count === 1 ? "" : "s"} ${pageList} from this working copy? You can undo this page change while this tab stays open. Your original PDF will not be changed.`)) return;
    const order = pageIds
      .map((_, index) => index)
      .filter((index) => !selected.has(pageIds[index]));
    const remainingIds = order.map((index) => pageIds[index]);
    const currentActiveId = pageIds[pageIndex];
    const nextActiveId = remainingIds.includes(currentActiveId)
      ? currentActiveId
      : remainingIds[Math.min(pageIndex, remainingIds.length - 1)];
    void applyPageOrder(
      order,
      nextActiveId,
      [],
      `Removed ${count} page${count === 1 ? "" : "s"} from the working copy. The original PDF is unchanged.`,
    );
  }, [applyPageOrder, busy, pageIds, pageIndex, selectedPageIds]);

  const extractSelectedPages = useCallback(async () => {
    const current = engineRef.current;
    if (!current || busy || !selectedPageIds.length) return;
    const selected = new Set(selectedPageIds);
    const pageOrder = pageIds
      .map((id, index) => selected.has(id) ? index : -1)
      .filter((index) => index >= 0);
    if (!pageOrder.length) return;
    setBusy(true);
    const handle = beginOperation(`Extracting ${pageOrder.length} selected page${pageOrder.length === 1 ? "" : "s"} locally…`);
    setStatus(`Extracting ${pageOrder.length} selected page${pageOrder.length === 1 ? "" : "s"} locally…`);
    try {
      const bytes = await current.exportPdf(edits, pageOrder, {
        ...handle.options,
        annotations: exportAnnotations,
      });
      const baseName = fileName.replace(/\.pdf$/i, "") || "document";
      const contiguous = pageOrder.every((value, index) => index === 0 || value === pageOrder[index - 1] + 1);
      const suffix = contiguous
        ? `pages-${pageOrder[0] + 1}${pageOrder.length > 1 ? `-${pageOrder.at(-1)! + 1}` : ""}`
        : `${pageOrder.length}-selected-pages`;
      const downloadName = `${baseName}-${suffix}.pdf`;
      downloadPdfBytes(bytes, downloadName);
      setStatus(`Download requested for ${downloadName}. The working PDF and unsaved edits were not changed; retry if your browser did not start the download.`);
    } catch (error) {
      setStatus(isAbortError(error)
        ? "Selected-page export cancelled. The working PDF is unchanged."
        : `Could not extract the selected pages: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      endOperation(handle);
    }
  }, [beginOperation, busy, edits, endOperation, exportAnnotations, fileName, pageIds, selectedPageIds]);

  const splitPdf = useCallback(async (request: SplitRequest) => {
    const current = engineRef.current;
    if (!current || busy) return;
    const result = buildSplitPlan(request, current.pageInfos.length);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    const { groups } = result.plan;
    if (groups.length > 200 && !window.confirm(
      `This will create ${groups.length} separate PDFs in one ZIP and may use substantial memory. Continue?`,
    )) return;

    setBusy(true);
    const handle = beginOperation(`Preparing ${groups.length} split PDF${groups.length === 1 ? "" : "s"}…`);
    setStatus(`Preparing ${groups.length} split PDF${groups.length === 1 ? "" : "s"} locally…`);
    try {
      const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      const splitOutputLimit = splitOutputLimitBytes(deviceMemory);
      const splitOutputLimitMb = bytesToWholeMebibytes(splitOutputLimit);
      const rawBaseName = fileName.replace(/\.pdf$/i, "") || "document";
      const safeBaseName = rawBaseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
      const entries: Array<{ name: string; data: Uint8Array<ArrayBuffer> }> = [];
      const suffixCounts = new Map<string, number>();
      let outputBytes = 0;

      for (const [groupIndex, group] of groups.entries()) {
        if (handle.controller.signal.aborted) {
          throw new DOMException("The PDF operation was cancelled.", "AbortError");
        }
        const partNumber = groupIndex + 1;
        updateOperation(
          handle,
          `Creating ${group.label} (${partNumber} of ${groups.length})…`,
          groupIndex,
          groups.length + 1,
        );
        const bytes = await current.exportPdf(edits, group.pageIndices, {
          signal: handle.controller.signal,
          annotations: exportAnnotations,
          onProgress: (progress) => {
            const fraction = progress.total > 0 ? progress.completed / progress.total : 0;
            updateOperation(
              handle,
              `Creating ${group.label} (${partNumber} of ${groups.length})…`,
              groupIndex + fraction,
              groups.length + 1,
            );
          },
        });
        outputBytes += bytes.byteLength;
        if (outputBytes > splitOutputLimit) {
          throw new Error(
            `The split output exceeded this device's ${splitOutputLimitMb} MB in-memory safety limit. ` +
            "Create fewer files at once or choose larger page ranges.",
          );
        }
        const seen = suffixCounts.get(group.fileSuffix) ?? 0;
        suffixCounts.set(group.fileSuffix, seen + 1);
        const uniqueSuffix = seen === 0 ? group.fileSuffix : `${group.fileSuffix}-${seen + 1}`;
        entries.push({ name: `${safeBaseName}-${uniqueSuffix}.pdf`, data: bytes });
      }

      updateOperation(handle, "Packaging PDFs into one ZIP…", groups.length, groups.length + 1);
      const zipBytes = await createStoredZipInWorker(entries, {
        signal: handle.controller.signal,
        onProgress: ({ completed, total }) => {
          const fraction = total > 0 ? completed / total : 0;
          updateOperation(
            handle,
            `Packaging file ${completed} of ${total} into the ZIP…`,
            groups.length + fraction,
            groups.length + 1,
          );
        },
      });
      const downloadName = `${safeBaseName}-split.zip`;
      downloadZipBytes(zipBytes, downloadName);
      setStatus(`Download requested for ${downloadName} with ${groups.length} PDF${groups.length === 1 ? "" : "s"}. Your open document is unchanged.`);
    } catch (error) {
      setStatus(isAbortError(error)
        ? "Split export cancelled. Your open document is unchanged."
        : `Could not split this PDF: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      endOperation(handle);
    }
  }, [beginOperation, busy, edits, endOperation, exportAnnotations, fileName, updateOperation]);

  const downloadPdf = useCallback(async () => {
    if (!engine || busy) return;
    setBusy(true);
    const handle = beginOperation("Building and verifying your edited PDF…");
    setStatus("Building and verifying your edited PDF…");
    try {
      const bytes = await engine.exportPdf(edits, undefined, {
        ...handle.options,
        annotations: exportAnnotations,
      });
      const baseName = fileName.replace(/\.pdf$/i, "") || "document";
      const downloadName = `${baseName}-edited.pdf`;
      downloadPdfBytes(bytes, downloadName);
      setStatus(`Download requested for ${downloadName}. The original file was not changed or uploaded; retry if your browser did not start the download.`);
    } catch (error) {
      setStatus(isAbortError(error)
        ? "Export cancelled. Your working PDF and edits are still here."
        : `Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      endOperation(handle);
    }
  }, [beginOperation, busy, edits, endOperation, engine, exportAnnotations, fileName]);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!modalOpen) chooseFile();
      } else if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!modalOpen) void downloadPdf();
      } else if (modalOpen || isTypingTarget(event.target)) {
        return;
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (editorMode === "annotate") {
          if (event.shiftKey) redoAnnotationChange();
          else undoAnnotationChange();
        } else if (event.shiftKey) redo();
        else undo();
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (editorMode === "annotate") redoAnnotationChange();
        else redo();
      } else if (command && event.key === "0") {
        event.preventDefault();
        setZoom(1);
      } else if (!command && event.key === "PageUp" && engine) {
        event.preventDefault();
        setPageIndex((index) => Math.max(0, index - 1));
      } else if (!command && event.key === "PageDown" && engine) {
        event.preventDefault();
        setPageIndex((index) => Math.min(pages.length - 1, index + 1));
      } else if (!command && event.key === "Home" && engine) {
        event.preventDefault();
        setPageIndex(0);
      } else if (!command && event.key === "End" && engine) {
        event.preventDefault();
        setPageIndex(pages.length - 1);
      } else if (!command && event.key.toLowerCase() === "r" && engine) {
        event.preventDefault();
        rotateCurrent(event.shiftKey ? 270 : 90);
      } else if (!command && (event.key === "+" || event.key === "=") && engine) {
        setZoom((value) => Math.min(4, value * 1.25));
      } else if (!command && event.key === "-" && engine) {
        setZoom((value) => Math.max(0.5, value / 1.25));
      }
    };
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [chooseFile, downloadPdf, editorMode, engine, modalOpen, pages.length, redo, redoAnnotationChange, rotateCurrent, undo, undoAnnotationChange]);

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pendingPassword || busy) return;
    if (pendingPassword.purpose === "append") {
      await appendBytes(pendingPassword.file, pendingPassword.bytes, passwordValue, pendingPassword.ownerRequired);
    } else {
      await openBytes(pendingPassword.file, pendingPassword.bytes, passwordValue, pendingPassword.ownerRequired);
    }
  };

  return (
    <div
      className={`app ${dragActive ? "is-dragging-file" : ""}`}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        warmPdfWorker();
        if (!busy) setDragActive(true);
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        const files = Array.from(event.dataTransfer.files);
        if (engine && files.length) void acceptAddedFiles(files);
        else if (files[0]) void acceptFile(files[0]);
      }}
    >
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void acceptFile(file);
        }}
      />
      <input
        ref={addFileInputRef}
        className="visually-hidden"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept="application/pdf,.pdf"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void acceptAddedFiles(files);
        }}
      />

      <header className="app-header">
        <button
          ref={brandButtonRef}
          type="button"
          className="brand"
          onClick={() => setShowAbout(true)}
          aria-label="About CropRotate PDF"
          disabled={pendingPassword !== null}
        >
          <span className="brand-mark"><FileText size={21} /></span>
          <span><strong>CropRotate PDF</strong><small>Private browser tool</small></span>
        </button>

        <button
          ref={openButtonRef}
          type="button"
          className="open-button"
          aria-label={engine ? "Open another PDF" : "Open PDF"}
          onPointerEnter={warmPdfWorker}
          onFocus={warmPdfWorker}
          onTouchStart={warmPdfWorker}
          onClick={chooseFile}
          disabled={busy}
        >
          <FolderOpen size={18} />
          <span className="open-button-label">{engine ? "Open another" : "Open PDF"}</span>
        </button>

        <button
          ref={organizerButtonRef}
          type="button"
          className="organize-button"
          aria-label="Organize, merge, split, or extract PDF pages"
          onClick={openOrganizer}
          disabled={!engine || busy}
        >
          <Files size={18} />
          <span className="organize-button-label">Organize pages</span>
        </button>

        <div className="file-summary" aria-live="polite">
          {engine ? (
            <><strong>{fileName}</strong><span>{pages.length} pages · {(fileSize / 1024 / 1024).toFixed(1)} MB</span></>
          ) : (
            <><strong>No document open</strong><span>PDF files stay in this browser tab</span></>
          )}
        </div>

        <button
          ref={privacyButtonRef}
          type="button"
          className="privacy-badge"
          title="Processed locally — no document upload or server-side storage."
          aria-label="Privacy: processed locally with no document upload or server-side storage"
          onClick={openPrivacy}
          disabled={pendingPassword !== null}
        >
          <ShieldCheck size={16} />
          No upload · no storage
        </button>

        <div className="header-actions">
          <div className="pwa-actions" aria-label="App availability">
            {!pwa.online && (
              <span className="offline-badge" title="The app is running without a network connection">
                <WifiOff size={15} /> Offline
              </span>
            )}
            {pwa.canInstall && (
              <button type="button" className="pwa-button" onClick={() => void installApp()} disabled={busy}>
                <MonitorDown size={16} /> <span>Install app</span>
              </button>
            )}
            {pwa.updateAvailable && (
              <button type="button" className="pwa-button is-update" onClick={() => void applyAppUpdate()} disabled={busy}>
                <RefreshCw size={16} /> <span>Update ready</span>
              </button>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={editorMode === "annotate" ? "Undo annotation change" : "Undo crop or rotation change"}
            disabled={busy || (editorMode === "annotate" ? !canUndoAnnotations(annotationHistory) : !undoStack.length)}
            onClick={editorMode === "annotate" ? undoAnnotationChange : undo}
          >
            <Undo2 size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={editorMode === "annotate" ? "Redo annotation change" : "Redo crop or rotation change"}
            disabled={busy || (editorMode === "annotate" ? !canRedoAnnotations(annotationHistory) : !redoStack.length)}
            onClick={editorMode === "annotate" ? redoAnnotationChange : redo}
          >
            <Redo2 size={18} />
          </button>
          <button
            type="button"
            className="download-button"
            aria-label={busy ? "Working" : "Save edited PDF as a local copy"}
            disabled={!engine || busy || !dirty}
            onClick={() => void downloadPdf()}
          >
            <Download size={18} />
            <span>{busy ? "Working…" : "Save local copy"}</span>
          </button>
        </div>
      </header>

      {operation && (
        <section className="operation-banner" aria-label="PDF operation progress">
          <span className="operation-spinner" aria-hidden="true" />
          <div className="operation-copy">
            <strong>{operation.message}</strong>
            <span>Working locally in this browser — your document is not being uploaded.</span>
          </div>
          <progress
            aria-label={operation.message}
            max={operation.total > 0 ? operation.total : undefined}
            value={operation.total > 0 ? Math.min(operation.completed, operation.total) : undefined}
          />
          <button
            type="button"
            className="operation-cancel"
            onClick={cancelOperation}
            disabled={operation.message.startsWith("Cancelling")}
          >
            <CircleStop size={17} /> Cancel
          </button>
        </section>
      )}

      {engine && currentPage && currentEdit ? (
        <main className="workspace">
          <div className="mobile-document-summary" aria-live="polite" title={fileName}>
            <FileText size={14} aria-hidden="true" />
            <strong>{fileName}</strong>
            <span>{pages.length} page{pages.length === 1 ? "" : "s"}</span>
          </div>
          <PageRail
            engine={engine}
            pages={pages}
            pageIds={pageIds}
            edits={edits}
            activePage={pageIndex}
            onSelect={(index) => {
              setPageIndex(index);
              setZoom(1);
              setStatus(`Showing page ${index + 1}.`);
            }}
          />
          <PdfViewport
            engine={engine}
            pageInfo={currentPage}
            pageEdit={currentEdit}
            pageIndex={pageIndex}
            pageCount={pages.length}
            visualCrop={visualCrop}
            normalizedAspect={aspectNormalized}
            zoom={zoom}
            busy={busy}
            editorMode={editorMode}
            annotations={currentAnnotations}
            annotationTool={annotationTool}
            annotationStyle={activeAnnotationStyle}
            selectedAnnotationId={selectedAnnotationId}
            onZoomChange={setZoom}
            onEditorModeChange={(mode) => {
              setEditorMode(mode);
              setSelectedAnnotationId(null);
              setStatus(mode === "annotate"
                ? "Annotate mode ready. Choose a tool, then work directly on the page."
                : "Crop and rotate mode ready.");
            }}
            onCropCommit={cropCurrentPage}
            onCropReset={resetCrop}
            onAnnotationSelect={setSelectedAnnotationId}
            onAnnotationCreate={createPageAnnotation}
            onAnnotationUpdate={changePageAnnotation}
            onAnnotationDelete={deletePageAnnotation}
            onRequestText={(tool, point) => setTextDialogRequest({ tool, point })}
            onPlaceSignature={requestSignaturePlacement}
            onPageChange={(index) => {
              setPageIndex(index);
              setZoom(1);
            }}
            onStatus={setStatus}
          />
          {editorMode === "crop" ? (
            <Inspector
              pageInfo={currentPage}
              pageEdit={currentEdit}
              visualCrop={visualCrop}
              aspectPreset={aspectPreset}
              aspectLocked={aspectLocked}
              canUndo={undoStack.length > 0}
              canRedo={redoStack.length > 0}
              busy={busy}
              onAspectPresetChange={(preset) => {
                setAspectPreset(preset);
                if (preset === "Free") setAspectLocked(false);
              }}
              onAspectLockedChange={setAspectLocked}
              onRotate={rotateCurrent}
              onResetRotation={resetRotation}
              onCropCommit={cropCurrentPage}
              onResetCrop={resetCrop}
              onUndo={undo}
              onRedo={redo}
              onFitAspect={fitAspect}
              onAutoTrim={autoTrim}
              onBatchApply={applyBatch}
              onStatus={setStatus}
            />
          ) : (
            <AnnotationToolbar
              pageNumber={pageIndex + 1}
              activeTool={annotationTool}
              style={activeAnnotationStyle}
              busy={busy}
              hasSelection={selectedAnnotationId !== null}
              canUndo={canUndoAnnotations(annotationHistory)}
              canRedo={canRedoAnnotations(annotationHistory)}
              onToolChange={(tool) => {
                setAnnotationTool(tool);
                if (tool !== "select") setSelectedAnnotationId(null);
              }}
              onPrepareSignature={prepareSignature}
              onStyleChange={changeAnnotationStyle}
              onUndo={undoAnnotationChange}
              onRedo={redoAnnotationChange}
              onDuplicate={duplicateSelectedAnnotation}
              onDelete={deleteSelectedAnnotation}
            />
          )}
        </main>
      ) : (
        <main className="empty-state">
          <div className="empty-glow" aria-hidden="true" />
          <div className="empty-card">
            <div className="empty-icon"><UploadCloud size={30} /></div>
            <span className="eyebrow">No uploads. No account.</span>
            <h1>Crop, rotate, annotate, and sign PDFs,<br />privately in your browser.</h1>
            <p>Crop, rotate, draw, highlight, add text or a visual signature, split, merge, and organize PDF pages locally with a live preview. No file upload, account, or server-side document storage.</p>
            <button
              type="button"
              className="primary-hero-button"
              onPointerEnter={warmPdfWorker}
              onFocus={warmPdfWorker}
              onTouchStart={warmPdfWorker}
              onClick={chooseFile}
              disabled={busy}
            >
              <FolderOpen size={19} /> Select a PDF
            </button>
            <span className="drop-hint">or drop a PDF anywhere</span>
            <button type="button" className="privacy-promise" onClick={openPrivacy}>
              <ShieldCheck size={20} />
              <span>
                <strong>Private by design</strong>
                Your PDF stays temporarily in this tab. The app does not upload it or keep a server-side copy. You keep ownership of your files and outputs.
              </span>
            </button>
          </div>
          <div className="feature-strip" aria-label="Main features">
            <span><Sparkles size={16} /> Crop, draw &amp; visually sign</span>
            <span><Files size={16} /> Merge, split &amp; organize</span>
            <span><ShieldCheck size={16} /> Local &amp; offline-ready</span>
          </div>
        </main>
      )}

      <footer className="status-bar">
        <span className={`status-dot ${busy ? "is-busy" : ""}`} aria-hidden="true" />
        <span className="status-message" role="status" aria-live="polite">{status}</span>
        <span className="signature-note">Crop is not redaction · edits invalidate signatures.</span>
        {pwa.offlineReady && <span className="offline-ready-note">App ready offline</span>}
        <button type="button" className="status-link" onClick={openPrivacy}><ShieldCheck size={15} /> Privacy</button>
        <a href={sourceUrl} target="_blank" rel="noreferrer"><Github size={15} /> Source</a>
      </footer>

      {dragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <UploadCloud size={42} />
          <strong>{engine ? "Drop PDFs to add their pages" : "Drop your PDF here"}</strong>
          <small>Processed in this tab — not uploaded or stored by the site.</small>
        </div>
      )}

      {showOrganizer && engine && !pendingPassword && (
        <PageOrganizer
          engine={engine}
          pages={pages}
          pageIds={pageIds}
          edits={edits}
          activePage={pageIndex}
          selectedPageIds={selectedPageIdSet}
          busy={busy}
          status={operation?.message ?? status}
          addButtonRef={organizerAddButtonRef}
          onClose={closeOrganizer}
          onActivate={(index) => {
            setPageIndex(index);
            setZoom(1);
            setStatus(`Selected page ${index + 1} for editing.`);
          }}
          onToggleSelected={toggleSelectedPage}
          onReplaceSelection={setSelectedPageIds}
          onSelectAll={() => setSelectedPageIds([...pageIds])}
          onClearSelection={() => setSelectedPageIds([])}
          onMove={movePage}
          onMoveSelected={moveSelectedPages}
          onDuplicateSelected={duplicateSelectedPages}
          onSplit={(request) => void splitPdf(request)}
          canUndoStructure={structureUndoStack.length > 0}
          canRedoStructure={structureRedoStack.length > 0}
          onUndoStructure={undoStructure}
          onRedoStructure={redoStructure}
          onCancelOperation={operation ? cancelOperation : undefined}
          onAddPdf={chooseAddedFiles}
          onExtract={() => void extractSelectedPages()}
          onDelete={deleteSelectedPages}
          onDialogKeyDown={(event) => handleDialogKeyDown(event, closeOrganizer, busy)}
        />
      )}

      <SignatureDialog
        open={signatureDialogKind !== null}
        kind={signatureDialogKind ?? "signature"}
        busy={busy}
        initialValue={signatureDialogKind ? signatureDrafts[signatureDialogKind] : null}
        onCancel={() => {
          setSignatureDialogKind(null);
          setPendingSignaturePoint(null);
          setAnnotationTool("select");
          setStatus("Signature placement cancelled.");
        }}
        onConfirm={confirmSignatureDraft}
      />

      <TextAnnotationDialog
        open={textDialogRequest !== null}
        tool={textDialogRequest?.tool ?? "text"}
        busy={busy}
        onCancel={() => {
          setTextDialogRequest(null);
          setAnnotationTool("select");
          setStatus("Text placement cancelled.");
        }}
        onConfirm={placeTextAnnotation}
      />

      {pendingPassword && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-title"
            onKeyDown={(event) => handleDialogKeyDown(event, closePassword, busy)}
            onSubmit={(event) => void submitPassword(event)}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Cancel"
              disabled={busy}
              onClick={closePassword}
            >
              <X size={18} />
            </button>
            <div className="modal-icon"><ShieldCheck size={22} /></div>
            <h2 id="password-title">
              {pendingPassword.ownerRequired
                ? "Owner password required"
                : pendingPassword.purpose === "append"
                  ? "Unlock PDF to add pages"
                  : "Unlock this PDF"}
            </h2>
            <p>{pendingPassword.message}</p>
            <label className="field-label" htmlFor="pdf-password">Password</label>
            <input id="pdf-password" type="password" autoFocus autoComplete="off" value={passwordValue} onChange={(event) => setPasswordValue(event.target.value)} />
            <p className="privacy-copy">Your password is held only in this tab for the active editing session. It is not transmitted or stored on a server.</p>
            <button className="primary-button full-button" type="submit" disabled={busy}>
              {busy ? "Unlocking…" : pendingPassword.purpose === "append" ? "Unlock and add pages" : "Unlock PDF"}
            </button>
          </form>
        </div>
      )}

      {showAbout && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeAbout}>
          <section
            className="modal about-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onKeyDown={(event) => handleDialogKeyDown(event, closeAbout)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="modal-close" aria-label="Close" autoFocus onClick={closeAbout}><X size={18} /></button>
            <div className="modal-icon"><FileText size={22} /></div>
            <h2 id="about-title">CropRotate PDF</h2>
            <p>A private, open-source PDF crop, rotation, annotation, visual-signature, and page-organization tool. Documents are processed in this browser tab with MuPDF WebAssembly.</p>
            <ul>
              <li>No document uploads, accounts, or analytics</li>
              <li>Non-destructive CropBox editing</li>
              <li>Local drawing, highlighting, text, dates, marks, shapes, and visual signatures</li>
              <li>Local PDF merging, splitting, duplication, reordering, removal, and extraction</li>
              <li>Installable app shell for offline use after the first visit</li>
              <li>AGPL-3.0-or-later licensed</li>
            </ul>
            {pwa.canInstall && (
              <button className="primary-button full-button" type="button" onClick={() => void installApp()}>
                <MonitorDown size={17} /> Install this app
              </button>
            )}
            {pwa.manualInstallHint && <p className="install-hint">On iPhone or iPad, tap Share, then <strong>Add to Home Screen</strong>.</p>}
            {pwa.registrationError && <p className="install-hint">Offline setup is unavailable in this browser. The website still works while connected.</p>}
            <p className="legal-copy">You keep ownership of documents you open and outputs you create. Copyright © 2026 CropRotate PDF contributors. This program comes with no warranty.</p>
            <div className="about-links">
              <a className="primary-button full-button link-button" href={sourceUrl} target="_blank" rel="noreferrer"><Github size={17} /> Corresponding source</a>
              <a className="license-link" href={privacyUrl}>Read the privacy notice</a>
              <a className="license-link" href={licenseUrl} target="_blank" rel="noreferrer">Read the AGPL license</a>
            </div>
          </section>
        </div>
      )}

      {showPrivacy && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closePrivacy}>
          <section
            className="modal privacy-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-title"
            aria-describedby="privacy-summary"
            onKeyDown={(event) => handleDialogKeyDown(event, closePrivacy)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="modal-close" aria-label="Close privacy information" autoFocus onClick={closePrivacy}><X size={18} /></button>
            <div className="modal-icon"><ShieldCheck size={22} /></div>
            <h2 id="privacy-title">Privacy &amp; data ownership</h2>
            <p id="privacy-summary"><strong>Private by design.</strong> Your PDFs and passwords are processed only in this browser tab. This app does not upload them or store a server-side copy. Edits are temporary until you download the result; closing or reloading the tab discards the working session.</p>
            <ul className="privacy-list">
              <li>PDF bytes, previews, passwords, page organization, crop settings, annotations, visual signature templates, and undo history remain in this tab's memory during the working session.</li>
              <li>The app uses no cookies, local storage, browser database, analytics, or server database to store your documents or editing data.</li>
              <li>Only choosing <strong>Save local copy</strong>, <strong>Extract selected</strong>, or <strong>Split to ZIP</strong> requests an output download through your browser.</li>
              <li>Cropping changes the PDF's visible page box; it is not redaction and does not erase hidden content outside the crop.</li>
              <li>Visual signatures and initials are flattened marks for appearance only; they are not certificate-backed, identity-verified cryptographic digital signatures.</li>
              <li>The app is not a malware scanner or PDF sanitizer; active content and attachments may remain in exported files.</li>
              <li>GitHub Pages receives ordinary web-request metadata. For offline use, the service worker caches only the app's static code—not your PDFs, previews, edits, passwords, or output files.</li>
              <li>Browser extensions, operating-system memory handling, and cloud-synced download folders are outside this app's control.</li>
            </ul>
            <p className="ownership-copy"><strong>You keep control of your documents.</strong> This app does not claim ownership of files you open or outputs you create.</p>
            <a className="primary-button full-button link-button" href={privacyUrl}>Read the full privacy notice</a>
          </section>
        </div>
      )}
    </div>
  );
}
