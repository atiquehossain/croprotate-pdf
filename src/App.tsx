import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileText,
  Files,
  FolderOpen,
  Github,
  Redo2,
  ShieldCheck,
  Sparkles,
  Undo2,
  UploadCloud,
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
import type { PdfEngine } from "./pdf/engine";
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

type PdfEngineModule = typeof import("./pdf/engine");

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
}

let pdfEngineModulePromise: Promise<PdfEngineModule> | null = null;
const MAX_INPUT_FILE_BYTES = 75 * 1024 * 1024;
const MAX_WORKING_INPUT_BYTES = 100 * 1024 * 1024;

function loadPdfEngine(): Promise<PdfEngineModule> {
  if (pdfEngineModulePromise === null) {
    pdfEngineModulePromise = import("./pdf/engine").catch((error: unknown) => {
      pdfEngineModulePromise = null;
      throw error;
    });
  }
  return pdfEngineModulePromise;
}

function warmPdfEngine(): void {
  void loadPdfEngine().catch(() => {
    // Opening a PDF will retry and surface a useful error if warm-up failed.
  });
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
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>("Free");
  const [aspectLocked, setAspectLocked] = useState(false);
  const [status, setStatus] = useState("Open a PDF to begin.");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [pendingPassword, setPendingPassword] = useState<PendingPassword | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [showAbout, setShowAbout] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showOrganizer, setShowOrganizer] = useState(false);

  const pages = engine?.pageInfos ?? [];
  const currentPage = pages[pageIndex];
  const currentEdit = edits[pageIndex];
  const selectedPageIdSet = useMemo(() => new Set(selectedPageIds), [selectedPageIds]);
  const sourceUrl = useMemo(inferSourceUrl, []);
  const privacyUrl = `${import.meta.env.BASE_URL}privacy.html`;
  const licenseUrl = useMemo(
    () => sourceUrl === "https://github.com/"
      ? "https://www.gnu.org/licenses/agpl-3.0.html"
      : `${sourceUrl.replace(/\/$/, "")}/blob/main/LICENSE`,
    [sourceUrl],
  );
  const modalOpen = pendingPassword !== null || showAbout || showPrivacy || showOrganizer;

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
    if (!shouldWarmPdfEngineOnIdle()) return;

    const idleWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const idleHandle = idleWindow.requestIdleCallback?.(warmPdfEngine, { timeout: 3_000 });
    if (idleHandle !== undefined) {
      return () => idleWindow.cancelIdleCallback?.(idleHandle);
    }

    const timeoutHandle = window.setTimeout(warmPdfEngine, 1_500);
    return () => window.clearTimeout(timeoutHandle);
  }, []);

  useEffect(
    () => () => {
      engineRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

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

  const installDocument = useCallback((opened: PdfEngine, file: File) => {
    engineRef.current?.close();
    setEngine(opened);
    engineRef.current = opened;
    setFileName(file.name);
    setFileSize(file.size);
    setEdits(opened.pageInfos.map(() => ({ rotation: 0, crop: null })));
    setPageIds(createPageIds(opened.pageInfos.length));
    setSelectedPageIds([]);
    setUndoStack([]);
    setRedoStack([]);
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
  ) => {
    const previous = engineRef.current;
    setEngine(opened);
    engineRef.current = opened;
    previous?.close();
    setEdits([
      ...cloneEdits(edits),
      ...Array.from({ length: addedPageCount }, () => ({ rotation: 0 as Rotation, crop: null })),
    ]);
    setPageIds([...pageIds, ...createPageIds(addedPageCount)]);
    setUndoStack([]);
    setRedoStack([]);
    setFileName(combinedFileName(fileName));
    setFileSize(opened.byteLength);
    setDirty(true);
    setPendingPassword(null);
    setPasswordValue("");
    const fileCount = addedFiles.length;
    const encryptionNote = addedEncryptedPdf
      ? " The combined copy uses the first PDF's password settings."
      : "";
    setStatus(`Added ${addedPageCount} page${addedPageCount === 1 ? "" : "s"} from ${fileCount} PDF${fileCount === 1 ? "" : "s"} locally. Existing page edits were kept, edit history was reset, and nothing was uploaded.${encryptionNote}`);
  }, [edits, fileName, pageIds]);

  const openBytes = useCallback(
    async (file: File, bytes: Uint8Array, password?: string, ownerPasswordAttempt = false) => {
      setBusy(true);
      setStatus(`Opening ${file.name} locally…`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      try {
        const { PdfEngine: PdfEngineRuntime } = await loadPdfEngine();
        const opened = await PdfEngineRuntime.open(bytes, password);
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
        if (error instanceof Error && error.name === "PasswordRequiredError") {
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
        setBusy(false);
      }
    },
    [installDocument],
  );

  const acceptFile = useCallback(
    async (file: File) => {
      if (busy) {
        setStatus("Wait for the current PDF operation to finish.");
        return;
      }
      if (dirty && !window.confirm("Edits are not auto-saved. Open another PDF and discard the current unsaved edits?")) return;
      warmPdfEngine();
      setBusy(true);
      setStatus(`Reading ${file.name} locally…`);
      try {
        const bytes = await readPdfFile(file);
        await openBytes(file, bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Could not open ${file.name}: ${message}${engineRef.current ? " The previous PDF is still open." : ""}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, dirty, openBytes],
  );

  const chooseFile = useCallback(() => {
    if (busy) {
      setStatus("Wait for the current PDF operation to finish.");
      return;
    }
    warmPdfEngine();
    fileInputRef.current?.click();
  }, [busy]);

  const appendBytes = useCallback(
    async (file: File, bytes: Uint8Array, password?: string, ownerPasswordAttempt = false) => {
      const current = engineRef.current;
      if (!current) return;
      setBusy(true);
      setStatus(`Adding ${file.name} locally…`);
      let imported: PdfEngine | null = null;
      try {
        const { PdfEngine: PdfEngineRuntime } = await loadPdfEngine();
        imported = await PdfEngineRuntime.open(bytes, password);
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
        const combined = await current.append([imported]);
        installMergedDocument(combined, [file], addedPageCount, importedEncrypted);
        if (password !== undefined) {
          window.requestAnimationFrame(() => organizerAddButtonRef.current?.focus());
        }
      } catch (error) {
        if (error instanceof Error && error.name === "PasswordRequiredError") {
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
        setBusy(false);
      }
    },
    [installMergedDocument],
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
      warmPdfEngine();
      setBusy(true);
      setStatus(`Reading ${files.length} PDF${files.length === 1 ? "" : "s"} locally…`);
      if (files.length === 1) {
        try {
          const bytes = await readPdfFile(files[0]);
          await appendBytes(files[0], bytes);
        } catch (error) {
          setStatus(`Could not add ${files[0].name}: ${error instanceof Error ? error.message : String(error)} The current PDF is unchanged.`);
        } finally {
          setBusy(false);
        }
        return;
      }

      const imported: PdfEngine[] = [];
      try {
        const { PdfEngine: PdfEngineRuntime } = await loadPdfEngine();
        for (const file of files) {
          const bytes = await readPdfFile(file);
          try {
            const opened = await PdfEngineRuntime.open(bytes);
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
        const combined = await current.append(imported);
        installMergedDocument(
          combined,
          files,
          addedPageCount,
          imported.some((item) => item.encrypted),
        );
      } catch (error) {
        setStatus(`Could not add the selected PDFs: ${error instanceof Error ? error.message : String(error)} The current PDF is unchanged.`);
      } finally {
        imported.forEach((item) => item.close());
        setBusy(false);
      }
    },
    [appendBytes, busy, installMergedDocument],
  );

  const chooseAddedFiles = useCallback(() => {
    if (busy || !engineRef.current) return;
    warmPdfEngine();
    addFileInputRef.current?.click();
  }, [busy]);

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
      setStatus(`Analyzing page ${analyzedPage + 1} margins…`);
      try {
        const result = await engine.autoTrim(
          analyzedPage,
          rotation,
          sensitivity,
          padding,
          includeAnnotations,
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
        setStatus(`Auto-trim failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, commitEdits, currentEdit, edits, engine, pageIndex],
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
      setStatus("Rebuilding the page order locally…");
      try {
        const reordered = await current.reorganize(pageOrder);
        const nextEdits = pageOrder.map((index) => cloneEdits([edits[index]])[0]);
        const nextPageIds = pageOrder.map((index) => pageIds[index]);
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
        setFileSize(reordered.byteLength);
        setDirty(true);
        setStatus(`${message} Edit history was reset.`);
      } catch (error) {
        setStatus(`Could not reorganize the pages: ${error instanceof Error ? error.message : String(error)} The current PDF is unchanged.`);
      } finally {
        setBusy(false);
      }
    },
    [busy, edits, pageIds],
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
    if (!window.confirm(`Remove page${count === 1 ? "" : "s"} ${pageList} from this working copy? This cannot be undone in this session, and crop or rotation edits on those pages will be lost. Your original PDFs will not be changed.`)) return;
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
    setStatus(`Extracting ${pageOrder.length} selected page${pageOrder.length === 1 ? "" : "s"} locally…`);
    try {
      const bytes = await current.exportPdf(edits, pageOrder);
      const baseName = fileName.replace(/\.pdf$/i, "") || "document";
      const contiguous = pageOrder.every((value, index) => index === 0 || value === pageOrder[index - 1] + 1);
      const suffix = contiguous
        ? `pages-${pageOrder[0] + 1}${pageOrder.length > 1 ? `-${pageOrder.at(-1)! + 1}` : ""}`
        : `${pageOrder.length}-selected-pages`;
      const downloadName = `${baseName}-${suffix}.pdf`;
      downloadPdfBytes(bytes, downloadName);
      setStatus(`Download requested for ${downloadName}. The working PDF and unsaved edits were not changed; retry if your browser did not start the download.`);
    } catch (error) {
      setStatus(`Could not extract the selected pages: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, edits, fileName, pageIds, selectedPageIds]);

  const downloadPdf = useCallback(async () => {
    if (!engine || busy) return;
    setBusy(true);
    setStatus("Building and verifying your edited PDF…");
    try {
      const bytes = await engine.exportPdf(edits);
      const baseName = fileName.replace(/\.pdf$/i, "") || "document";
      const downloadName = `${baseName}-edited.pdf`;
      downloadPdfBytes(bytes, downloadName);
      setStatus(`Download requested for ${downloadName}. The original file was not changed or uploaded; retry if your browser did not start the download.`);
    } catch (error) {
      setStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, edits, engine, fileName]);

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
        if (event.shiftKey) redo();
        else undo();
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
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
  }, [chooseFile, downloadPdf, engine, modalOpen, pages.length, redo, rotateCurrent, undo]);

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
        warmPdfEngine();
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
          onPointerEnter={warmPdfEngine}
          onFocus={warmPdfEngine}
          onTouchStart={warmPdfEngine}
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
          aria-label="Organize, merge, or extract PDF pages"
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
          <button type="button" className="icon-button" aria-label="Undo" disabled={!undoStack.length || busy} onClick={undo}>
            <Undo2 size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="Redo" disabled={!redoStack.length || busy} onClick={redo}>
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
            onZoomChange={setZoom}
            onCropCommit={cropCurrentPage}
            onCropReset={resetCrop}
            onPageChange={(index) => {
              setPageIndex(index);
              setZoom(1);
            }}
            onStatus={setStatus}
          />
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
        </main>
      ) : (
        <main className="empty-state">
          <div className="empty-glow" aria-hidden="true" />
          <div className="empty-card">
            <div className="empty-icon"><UploadCloud size={30} /></div>
            <span className="eyebrow">No uploads. No account.</span>
            <h1>Crop, rotate, and organize PDFs,<br />privately in your browser.</h1>
            <p>Crop, rotate, merge, reorder, extract, and batch-edit PDF pages locally with a live preview. No file upload, account, or server-side document storage.</p>
            <button
              type="button"
              className="primary-hero-button"
              onPointerEnter={warmPdfEngine}
              onFocus={warmPdfEngine}
              onTouchStart={warmPdfEngine}
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
            <span><Sparkles size={16} /> Live precision crop</span>
            <span><Files size={16} /> Merge &amp; organize pages</span>
            <span><ShieldCheck size={16} /> No document upload</span>
          </div>
        </main>
      )}

      <footer className="status-bar">
        <span className={`status-dot ${busy ? "is-busy" : ""}`} aria-hidden="true" />
        <span className="status-message" role="status" aria-live="polite">{status}</span>
        <span className="signature-note">Crop is not redaction · edits invalidate signatures.</span>
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
          status={status}
          addButtonRef={organizerAddButtonRef}
          onClose={closeOrganizer}
          onActivate={(index) => {
            setPageIndex(index);
            setZoom(1);
            setStatus(`Selected page ${index + 1} for editing.`);
          }}
          onToggleSelected={toggleSelectedPage}
          onSelectAll={() => setSelectedPageIds([...pageIds])}
          onClearSelection={() => setSelectedPageIds([])}
          onMove={movePage}
          onAddPdf={chooseAddedFiles}
          onExtract={() => void extractSelectedPages()}
          onDelete={deleteSelectedPages}
          onDialogKeyDown={(event) => handleDialogKeyDown(event, closeOrganizer, busy)}
        />
      )}

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
            <p>A private, open-source PDF crop, rotation, and page-organization tool. Documents are processed in this browser tab with MuPDF WebAssembly.</p>
            <ul>
              <li>No document uploads, accounts, or analytics</li>
              <li>Non-destructive CropBox editing</li>
              <li>Local PDF merging, reordering, removal, and extraction</li>
              <li>AGPL-3.0-or-later licensed</li>
            </ul>
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
              <li>PDF bytes, previews, passwords, page organization, edits, and undo history remain in this tab's memory during the working session.</li>
              <li>The app uses no cookies, local storage, browser database, analytics, or server database to store your documents or editing data.</li>
              <li>Only choosing <strong>Save local copy</strong> or <strong>Extract selected</strong> requests an output download through your browser.</li>
              <li>Cropping changes the PDF's visible page box; it is not redaction and does not erase hidden content outside the crop.</li>
              <li>The app is not a malware scanner or PDF sanitizer; active content and attachments may remain in exported files.</li>
              <li>GitHub Pages receives ordinary web-request metadata, and your browser may cache the app's static code. Your selected PDFs are not included in those requests.</li>
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
