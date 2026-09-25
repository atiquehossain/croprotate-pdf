import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileText,
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
import { PdfViewport } from "./components/PdfViewport";

interface PendingPassword {
  file: File;
  bytes: Uint8Array;
  message: string;
  ownerRequired: boolean;
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
  if (!focusable.length) return;
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
  const engineRef = useRef<PdfEngine | null>(null);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const privacyButtonRef = useRef<HTMLButtonElement>(null);
  const privacyReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [edits, setEdits] = useState<PageEdit[]>([]);
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

  const pages = engine?.pageInfos ?? [];
  const currentPage = pages[pageIndex];
  const currentEdit = edits[pageIndex];
  const sourceUrl = useMemo(inferSourceUrl, []);
  const privacyUrl = `${import.meta.env.BASE_URL}privacy.html`;
  const licenseUrl = useMemo(
    () => sourceUrl === "https://github.com/"
      ? "https://www.gnu.org/licenses/agpl-3.0.html"
      : `${sourceUrl.replace(/\/$/, "")}/blob/main/LICENSE`,
    [sourceUrl],
  );
  const modalOpen = pendingPassword !== null || showAbout || showPrivacy;

  const closePassword = useCallback(() => {
    if (busy) return;
    setPendingPassword(null);
    setPasswordValue("");
    setStatus(engine ? "Kept the current PDF open." : "Open a PDF to begin.");
    window.requestAnimationFrame(() => openButtonRef.current?.focus());
  }, [busy, engine]);

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

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

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
    setUndoStack([]);
    setRedoStack([]);
    setPageIndex(0);
    setZoom(1);
    setAspectPreset("Free");
    setAspectLocked(false);
    setDirty(false);
    setPendingPassword(null);
    setPasswordValue("");
    setStatus(`Loaded ${opened.pageInfos.length} page${opened.pageInfos.length === 1 ? "" : "s"} locally. No document copy was uploaded or stored by the app.`);
  }, []);

  const openBytes = useCallback(
    async (file: File, bytes: Uint8Array, password?: string) => {
      setBusy(true);
      setStatus("Opening PDF locally…");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      try {
        const { PdfEngine: PdfEngineRuntime } = await import("./pdf/engine");
        const opened = await PdfEngineRuntime.open(bytes, password);
        if (!opened.canEdit) {
          opened.close();
          setPendingPassword({
            file,
            bytes,
            ownerRequired: true,
            message: "That password opens the PDF for viewing, but editing is restricted. Enter the owner password.",
          });
          setPasswordValue("");
          setStatus("The owner password is required to edit this PDF.");
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
            ownerRequired: false,
            message: error.message,
          });
          setPasswordValue("");
          setStatus("Password required.");
        } else {
          setStatus(error instanceof Error ? error.message : String(error));
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
      if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
        setStatus("Choose a PDF file.");
        return;
      }
      setBusy(true);
      setStatus("Reading PDF locally…");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const header = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
        if (!header.includes("%PDF-")) throw new Error("This file does not have a valid PDF header.");
        await openBytes(file, bytes);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
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
    fileInputRef.current?.click();
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

  const downloadPdf = useCallback(async () => {
    if (!engine || busy) return;
    setBusy(true);
    setStatus("Building and verifying your edited PDF…");
    try {
      const bytes = await engine.exportPdf(edits);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const baseName = fileName.replace(/\.pdf$/i, "") || "document";
      anchor.href = url;
      anchor.download = `${baseName}-edited.pdf`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setDirty(false);
      setStatus(`Saved ${anchor.download} to your device. The original file was not changed, and this app did not upload a copy.`);
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
    await openBytes(pendingPassword.file, pendingPassword.bytes, passwordValue);
  };

  return (
    <div
      className={`app ${dragActive ? "is-dragging-file" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!busy) setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        const file = event.dataTransfer.files[0];
        if (file) void acceptFile(file);
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
          onClick={chooseFile}
          disabled={busy}
        >
          <FolderOpen size={18} />
          <span className="open-button-label">{engine ? "Open another" : "Open PDF"}</span>
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
          <PageRail
            engine={engine}
            pages={pages}
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
            <h1>Crop and rotate PDFs,<br />privately in your browser.</h1>
            <p>Crop, rotate, auto-trim, and batch-edit PDFs locally with a live preview. No file upload, account, or server-side document storage.</p>
            <button type="button" className="primary-hero-button" onClick={chooseFile} disabled={busy}>
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
            <span><ShieldCheck size={16} /> No document upload</span>
            <span><Download size={16} /> Download when ready</span>
          </div>
        </main>
      )}

      <footer className="status-bar">
        <span className={`status-dot ${busy ? "is-busy" : ""}`} aria-hidden="true" />
        <span className="status-message" role="status" aria-live="polite">{status}</span>
        <span className="signature-note">Edits invalidate existing digital signatures.</span>
        <button type="button" className="status-link" onClick={openPrivacy}><ShieldCheck size={15} /> Privacy</button>
        <a href={sourceUrl} target="_blank" rel="noreferrer"><Github size={15} /> Source</a>
      </footer>

      {dragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <UploadCloud size={42} />
          <strong>Drop your PDF here</strong>
          <small>Processed in this tab — not uploaded or stored by the site.</small>
        </div>
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
            <h2 id="password-title">{pendingPassword.ownerRequired ? "Owner password required" : "Unlock this PDF"}</h2>
            <p>{pendingPassword.message}</p>
            <label className="field-label" htmlFor="pdf-password">Password</label>
            <input id="pdf-password" type="password" autoFocus autoComplete="off" value={passwordValue} onChange={(event) => setPasswordValue(event.target.value)} />
            <p className="privacy-copy">Your password is held only in this tab for the active editing session. It is not transmitted or stored on a server.</p>
            <button className="primary-button full-button" type="submit" disabled={busy}>{busy ? "Unlocking…" : "Unlock PDF"}</button>
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
            <p>A private, open-source PDF crop and rotation tool. Documents are processed in this browser tab with MuPDF WebAssembly.</p>
            <ul>
              <li>No document uploads, accounts, or analytics</li>
              <li>Non-destructive CropBox editing</li>
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
            <p id="privacy-summary"><strong>Private by design.</strong> Your PDF and password are processed only in this browser tab. This app does not upload them or store a server-side copy. Edits are temporary until you download the result; closing or reloading the tab discards the working session.</p>
            <ul className="privacy-list">
              <li>PDF bytes, previews, passwords, edits, and undo history remain in this tab's memory during the working session.</li>
              <li>The app uses no cookies, local storage, browser database, analytics, or server database to store your documents or editing data.</li>
              <li>Only choosing <strong>Save local copy</strong> creates an output file, using your browser's normal download behavior.</li>
              <li>GitHub Pages receives ordinary web-request metadata, and your browser may cache the app's static code. Your selected PDF is not included in those requests.</li>
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
