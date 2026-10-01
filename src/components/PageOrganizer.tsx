import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Download,
  FilePlus,
  FilePlus2,
  GripVertical,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { PageEdit, PageInfo } from "../types";
import type { PdfWorkerDocument } from "../pdf/workerClient";
import { totalRotation, visualPageDimensions } from "../pdf/geometry";
import {
  blockDropInsertion,
  blockInsertionForDirection,
  buildSplitPlan,
  selectionForPreset,
  selectionWithRange,
  type SelectionPreset,
  type SplitRequest,
} from "./organizerTools";

export interface InsertBlankPageRequest {
  /** Zero-based slot before which the new page is inserted. May equal page count. */
  insertAt: number;
  /** Match the page immediately before the insertion point. */
  size: "match-neighbor";
}

interface OrganizerThumbnailProps {
  engine: PdfWorkerDocument;
  info: PageInfo;
  edit: PageEdit;
  pageId: string;
  position: number;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  moveSelectionCount: number;
  active: boolean;
  selected: boolean;
  busy: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onActivate: () => void;
  onToggle: (shiftKey: boolean, selected: boolean) => void;
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

function OrganizerThumbnail({
  engine,
  info,
  edit,
  pageId,
  position,
  canMoveEarlier,
  canMoveLater,
  moveSelectionCount,
  active,
  selected,
  busy,
  dragging,
  dropTarget,
  onActivate,
  onToggle,
  onMoveEarlier,
  onMoveLater,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: OrganizerThumbnailProps) {
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(active || entry.isIntersecting),
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => void (async () => {
      try {
        const rotation = totalRotation(info, edit.rotation);
        const [width, height] = visualPageDimensions(info, rotation);
        const scale = Math.min(164 / width, 190 / height, 0.38);
        const rendered = await engine.renderPage(
          info.index,
          edit.rotation,
          scale,
          true,
          { signal: controller.signal },
        );
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        context.putImageData(
          new ImageData(rendered.pixels, rendered.width, rendered.height),
          0,
          0,
        );
      } catch {
        // Keep the numbered placeholder usable when a thumbnail cannot render.
      }
    })());
    return () => {
      cancelled = true;
      controller.abort();
      window.cancelAnimationFrame(frame);
    };
  }, [edit.rotation, engine, info, visible]);

  return (
    <article
      ref={rootRef}
      className={`organizer-card ${active ? "is-active" : ""} ${selected ? "is-selected" : ""} ${dragging ? "is-dragging" : ""} ${dropTarget ? "is-drop-target" : ""}`}
      role="listitem"
      draggable={!busy}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-page-id={pageId}
    >
      <div className="organizer-card-topline">
        <label className="organizer-check" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            disabled={busy}
            onChange={(event) => {
              const nativeEvent = event.nativeEvent;
              const shiftKey = "shiftKey" in nativeEvent && Boolean(nativeEvent.shiftKey);
              onToggle(shiftKey, event.currentTarget.checked);
            }}
            aria-label={`Select page ${position + 1}`}
          />
          <span>{position + 1}</span>
        </label>
        <span className="organizer-drag-hint" title={moveSelectionCount > 1 ? `Drag ${moveSelectionCount} selected pages together` : "Drag to reorder"} aria-hidden="true">
          <GripVertical size={17} />
        </span>
      </div>

      <button
        type="button"
        className="organizer-preview"
        onClick={onActivate}
        disabled={busy}
        aria-label={`Edit page ${position + 1}`}
        aria-current={active ? "page" : undefined}
      >
        <span className="organizer-paper">
          {visible ? <canvas ref={canvasRef} aria-hidden="true" /> : <span>{position + 1}</span>}
        </span>
        <span className="organizer-page-label">Page {position + 1}</span>
      </button>

      <div className="organizer-move-controls" role="group" aria-label={`Move page ${position + 1}`}>
        <button
          type="button"
          onClick={onMoveEarlier}
          disabled={busy || !canMoveEarlier}
          aria-label={moveSelectionCount > 1 ? `Move ${moveSelectionCount} selected pages earlier` : `Move page ${position + 1} earlier`}
          title="Move earlier"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          onClick={onMoveLater}
          disabled={busy || !canMoveLater}
          aria-label={moveSelectionCount > 1 ? `Move ${moveSelectionCount} selected pages later` : `Move page ${position + 1} later`}
          title="Move later"
        >
          <ArrowRight size={16} />
        </button>
      </div>
    </article>
  );
}

export interface PageOrganizerProps {
  engine: PdfWorkerDocument;
  pages: PageInfo[];
  pageIds: string[];
  edits: PageEdit[];
  activePage: number;
  selectedPageIds: ReadonlySet<string>;
  busy: boolean;
  status: string;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onActivate: (index: number) => void;
  onToggleSelected: (pageId: string) => void;
  /** Preferred atomic selection update; the component falls back to toggles. */
  onReplaceSelection?: (pageIds: string[]) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onMove: (from: number, to: number) => void;
  /** Insert selected IDs, in their current order, into this slot among unselected pages. */
  onMoveSelected?: (pageIds: readonly string[], insertionIndex: number) => void;
  onDuplicateSelected?: (pageIds: readonly string[]) => void;
  onInsertBlank?: (request: InsertBlankPageRequest) => void;
  /** App owns ZIP creation, progress, download, and cancellation. */
  onSplit?: (request: SplitRequest) => void;
  canUndoStructure?: boolean;
  canRedoStructure?: boolean;
  onUndoStructure?: () => void;
  onRedoStructure?: () => void;
  onCancelOperation?: () => void;
  onAddPdf: () => void;
  onExtract: () => void;
  onDelete: () => void;
  onDialogKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export function PageOrganizer({
  engine,
  pages,
  pageIds,
  edits,
  activePage,
  selectedPageIds,
  busy,
  status,
  addButtonRef,
  onClose,
  onActivate,
  onToggleSelected,
  onReplaceSelection,
  onSelectAll,
  onClearSelection,
  onMove,
  onMoveSelected,
  onDuplicateSelected,
  onInsertBlank,
  onSplit,
  canUndoStructure = false,
  canRedoStructure = false,
  onUndoStructure,
  onRedoStructure,
  onCancelOperation,
  onAddPdf,
  onExtract,
  onDelete,
  onDialogKeyDown,
}: PageOrganizerProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const splitButtonRef = useRef<HTMLButtonElement>(null);
  const splitPanelRef = useRef<HTMLFormElement>(null);
  const selectionAnchorIdRef = useRef<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitMode, setSplitMode] = useState<SplitRequest["mode"]>("ranges");
  const [rangeText, setRangeText] = useState("");
  const [everyText, setEveryText] = useState(() => String(Math.min(10, pages.length)));
  const [splitAttempted, setSplitAttempted] = useState(false);
  const selectedCount = selectedPageIds.size;
  const orderedSelectedIds = useMemo(
    () => pageIds.filter((pageId) => selectedPageIds.has(pageId)),
    [pageIds, selectedPageIds],
  );
  const earlierInsertion = useMemo(
    () => blockInsertionForDirection(pageIds, selectedPageIds, "earlier"),
    [pageIds, selectedPageIds],
  );
  const laterInsertion = useMemo(
    () => blockInsertionForDirection(pageIds, selectedPageIds, "later"),
    [pageIds, selectedPageIds],
  );
  const splitRequest = useMemo<SplitRequest>(() => {
    if (splitMode === "ranges") return { mode: "ranges", rangeText: rangeText.trim() };
    if (splitMode === "every") return { mode: "every", everyN: Number(everyText) };
    return { mode: "each" };
  }, [everyText, rangeText, splitMode]);
  const splitPlan = useMemo(
    () => buildSplitPlan(splitRequest, pages.length),
    [pages.length, splitRequest],
  );

  const finishDrag = () => {
    setDraggedIndex(null);
    setDropIndex(null);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (!dialog) return;
    if (
      !(active instanceof HTMLElement) ||
      !dialog.contains(active) ||
      ((active instanceof HTMLButtonElement || active instanceof HTMLInputElement) && active.disabled)
    ) {
      dialog.focus();
    }
  }, [busy, selectedCount]);

  useEffect(() => {
    if (!splitOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = splitPanelRef.current;
      const firstField = panel?.querySelector<HTMLInputElement>("input:not([type='radio'])")
        ?? panel?.querySelector<HTMLInputElement>("input[type='radio']:checked");
      firstField?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [splitOpen]);

  const commitSelection = (nextPageIds: string[]) => {
    if (onReplaceSelection) {
      onReplaceSelection(nextPageIds);
      return;
    }
    const next = new Set(nextPageIds);
    pageIds.forEach((pageId) => {
      if (selectedPageIds.has(pageId) !== next.has(pageId)) onToggleSelected(pageId);
    });
  };

  const choosePreset = (preset: SelectionPreset) => {
    const next = selectionForPreset(pageIds, selectedPageIds, preset);
    if (preset === "all") onSelectAll();
    else if (preset === "clear") onClearSelection();
    else commitSelection(next);
    selectionAnchorIdRef.current = null;
  };

  const togglePage = (pageId: string, index: number, shiftKey: boolean, selected: boolean) => {
    const anchorIndex = selectionAnchorIdRef.current
      ? pageIds.indexOf(selectionAnchorIdRef.current)
      : -1;
    if (shiftKey && anchorIndex >= 0) {
      commitSelection(selectionWithRange(pageIds, selectedPageIds, anchorIndex, index, selected));
    } else {
      onToggleSelected(pageId);
    }
    selectionAnchorIdRef.current = pageId;
  };

  const moveSelected = (direction: "earlier" | "later") => {
    const insertionIndex = direction === "earlier" ? earlierInsertion : laterInsertion;
    if (insertionIndex === null || !onMoveSelected) return;
    onMoveSelected(orderedSelectedIds, insertionIndex);
  };

  const closeSplitPanel = () => {
    setSplitOpen(false);
    setSplitAttempted(false);
    window.requestAnimationFrame(() => {
      const splitButton = splitButtonRef.current;
      if (splitButton && !splitButton.disabled) splitButton.focus();
      else dialogRef.current?.focus();
    });
  };

  const submitSplit = (event: React.FormEvent) => {
    event.preventDefault();
    setSplitAttempted(true);
    if (!onSplit || !splitPlan.ok) return;
    onSplit(splitRequest);
    closeSplitPanel();
  };

  const splitHelp = (() => {
    if (!splitPlan.ok) {
      if (!splitAttempted && splitMode === "ranges" && !rangeText.trim()) {
        return { kind: "help", text: "Use commas to create separate PDFs. “end” means the last page." };
      }
      return { kind: "error", text: splitPlan.error };
    }
    const outputCount = splitPlan.plan.groups.length;
    return {
      kind: outputCount > 200 ? "warning" : "ready",
      text: `${outputCount} PDF${outputCount === 1 ? "" : "s"} will be placed in one ZIP${outputCount > 200 ? ". This large export may take a while" : ""}.`,
    };
  })();

  return (
    <div className="modal-backdrop organizer-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="page-organizer"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="organizer-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && splitOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeSplitPanel();
            return;
          }
          onDialogKeyDown(event);
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="organizer-header">
          <div>
            <span className="eyebrow">Private page tools</span>
            <h2 id="organizer-title">Organize pages</h2>
            <p>Merge, arrange, duplicate, split, or extract pages. Everything stays in this tab.</p>
          </div>
          <button
            type="button"
            className="modal-close organizer-close"
            aria-label="Close page organizer"
            onClick={onClose}
            disabled={busy}
            autoFocus
          >
            <X size={19} />
          </button>
        </header>

        <div className="organizer-toolbar">
          <button
            ref={addButtonRef}
            type="button"
            className="organizer-action is-primary"
            onClick={onAddPdf}
            disabled={busy}
          >
            <FilePlus2 size={17} /> Add PDFs
          </button>
          {onInsertBlank && (
            <button
              type="button"
              className="organizer-action"
              onClick={() => onInsertBlank({ insertAt: Math.min(pages.length, activePage + 1), size: "match-neighbor" })}
              disabled={busy}
              title={`Insert a blank page after page ${activePage + 1}`}
            >
              <FilePlus size={17} /> Blank after current
            </button>
          )}
          {onSplit && (
            <button
              ref={splitButtonRef}
              type="button"
              className={`organizer-action ${splitOpen ? "is-active" : ""}`}
              onClick={() => {
                setSplitAttempted(false);
                setSplitOpen((current) => !current);
              }}
              disabled={busy}
              aria-expanded={splitOpen}
              aria-controls="organizer-split-panel"
            >
              <Scissors size={17} /> Split to ZIP
            </button>
          )}
          <span className="organizer-toolbar-spacer" />
          {(onUndoStructure || onRedoStructure) && (
            <div className="organizer-history" role="group" aria-label="Page change history">
              <button type="button" className="organizer-icon-action" onClick={onUndoStructure} disabled={busy || !canUndoStructure} aria-label="Undo page change" title="Undo page change">
                <Undo2 size={17} />
              </button>
              <button type="button" className="organizer-icon-action" onClick={onRedoStructure} disabled={busy || !canRedoStructure} aria-label="Redo page change" title="Redo page change">
                <Redo2 size={17} />
              </button>
            </div>
          )}
        </div>

        <div className="organizer-context">
          <div className="organizer-status-row">
            <p className="organizer-operation-status" role="status" aria-live="polite">{status}</p>
            {busy && onCancelOperation && (
              <button type="button" className="organizer-cancel" onClick={onCancelOperation}>Cancel</button>
            )}
          </div>

          {splitOpen && onSplit && (
            <form id="organizer-split-panel" className="organizer-split-panel" ref={splitPanelRef} onSubmit={submitSplit}>
              <div className="organizer-split-heading">
                <div>
                  <strong>Split into separate PDFs</strong>
                  <span>Downloaded together as one ZIP. Your open document stays unchanged.</span>
                </div>
                <button type="button" className="organizer-split-close" onClick={closeSplitPanel} aria-label="Close split options"><X size={17} /></button>
              </div>
              <fieldset className="organizer-split-modes">
                <legend className="visually-hidden">Choose how to split the PDF</legend>
                {([
                  ["ranges", "Page ranges"],
                  ["every", "Every N pages"],
                  ["each", "Each page"],
                ] as const).map(([mode, label]) => (
                  <label key={mode} className={splitMode === mode ? "is-active" : ""}>
                    <input
                      type="radio"
                      name="split-mode"
                      value={mode}
                      checked={splitMode === mode}
                      onChange={() => {
                        setSplitMode(mode);
                        setSplitAttempted(false);
                      }}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <div className="organizer-split-entry">
                {splitMode === "ranges" && (
                  <label>
                    <span>Ranges</span>
                    <input
                      type="text"
                      inputMode="text"
                      value={rangeText}
                      onChange={(event) => {
                        setRangeText(event.target.value);
                        setSplitAttempted(false);
                      }}
                      placeholder="1-3, 6, 9-end"
                      aria-describedby="organizer-split-feedback"
                      aria-invalid={splitHelp.kind === "error"}
                    />
                  </label>
                )}
                {splitMode === "every" && (
                  <label>
                    <span>Pages per PDF</span>
                    <input
                      type="number"
                      min="1"
                      max={pages.length}
                      step="1"
                      value={everyText}
                      onChange={(event) => {
                        setEveryText(event.target.value);
                        setSplitAttempted(false);
                      }}
                      aria-describedby="organizer-split-feedback"
                      aria-invalid={splitHelp.kind === "error"}
                    />
                  </label>
                )}
                {splitMode === "each" && (
                  <p className="organizer-each-summary">Create one PDF for every page in this {pages.length}-page document.</p>
                )}
                <p id="organizer-split-feedback" className={`organizer-split-feedback is-${splitHelp.kind}`} role={splitHelp.kind === "error" ? "alert" : "status"}>
                  {splitHelp.text}
                </p>
                <button type="submit" className="organizer-action is-primary organizer-split-submit" disabled={busy || !splitPlan.ok}>
                  <Download size={17} /> Create ZIP
                </button>
              </div>
            </form>
          )}

          <div className="organizer-selection-panel" role="group" aria-label="Page selection and actions">
            <div className="organizer-selection-presets" role="group" aria-label="Select pages">
              <span>Select:</span>
              <button type="button" onClick={() => choosePreset("all")} disabled={busy || selectedCount === pages.length}>All</button>
              <button type="button" onClick={() => choosePreset("odd")} disabled={busy}>Odd</button>
              <button type="button" onClick={() => choosePreset("even")} disabled={busy}>Even</button>
              <button type="button" onClick={() => choosePreset("invert")} disabled={busy}>Invert</button>
            </div>
            <span className="organizer-selection" role="status" aria-live="polite">
              {selectedCount ? `${selectedCount} page${selectedCount === 1 ? "" : "s"} selected` : "Tip: Shift-click a checkbox to select a range"}
            </span>
            <div className="organizer-bulk-actions" aria-label="Selected page actions">
              {onMoveSelected && (
                <>
                  <button type="button" onClick={() => moveSelected("earlier")} disabled={busy || selectedCount === 0 || earlierInsertion === null} title="Move selected pages together earlier">
                    <ArrowLeft size={16} /> <span>Earlier</span>
                  </button>
                  <button type="button" onClick={() => moveSelected("later")} disabled={busy || selectedCount === 0 || laterInsertion === null} title="Move selected pages together later">
                    <span>Later</span><ArrowRight size={16} />
                  </button>
                </>
              )}
              {onDuplicateSelected && (
                <button type="button" onClick={() => onDuplicateSelected(orderedSelectedIds)} disabled={busy || selectedCount === 0} title="Duplicate selected pages after their originals">
                  <Copy size={16} /> <span>Duplicate</span>
                </button>
              )}
              <button type="button" onClick={onExtract} disabled={busy || selectedCount === 0}>
                <Download size={16} /> <span>Extract</span>
              </button>
              <button type="button" className="is-danger" onClick={onDelete} disabled={busy || selectedCount === 0 || selectedCount >= pages.length} title={selectedCount >= pages.length ? "Keep at least one page" : "Remove selected pages"}>
                <Trash2 size={16} /> <span>Remove</span>
              </button>
              <button type="button" onClick={() => choosePreset("clear")} disabled={busy || selectedCount === 0}>Clear</button>
            </div>
          </div>
        </div>

        <div className="organizer-grid" role="list" aria-label={`${pages.length} document pages`}>
          {pages.map((page, index) => {
            const pageId = pageIds[index];
            const draggingSelectedBlock = draggedIndex !== null
              && selectedCount > 1
              && Boolean(onMoveSelected)
              && selectedPageIds.has(pageIds[draggedIndex]);
            return (
              <OrganizerThumbnail
                key={pageId}
                engine={engine}
                info={page}
                edit={edits[index]}
                pageId={pageId}
                position={index}
                canMoveEarlier={selectedCount > 1 && selectedPageIds.has(pageId) && onMoveSelected ? earlierInsertion !== null : index > 0}
                canMoveLater={selectedCount > 1 && selectedPageIds.has(pageId) && onMoveSelected ? laterInsertion !== null : index + 1 < pages.length}
                moveSelectionCount={selectedCount > 1 && selectedPageIds.has(pageId) && onMoveSelected ? selectedCount : 1}
                active={index === activePage}
                selected={selectedPageIds.has(pageId)}
                busy={busy}
                dragging={draggedIndex === index || (draggingSelectedBlock && selectedPageIds.has(pageId))}
                dropTarget={dropIndex === index && draggedIndex !== index && !(draggingSelectedBlock && selectedPageIds.has(pageId))}
                onActivate={() => onActivate(index)}
                onToggle={(shiftKey, selected) => togglePage(pageId, index, shiftKey, selected)}
                onMoveEarlier={() => {
                  if (selectedCount > 1 && selectedPageIds.has(pageId) && onMoveSelected) moveSelected("earlier");
                  else onMove(index, index - 1);
                }}
                onMoveLater={() => {
                  if (selectedCount > 1 && selectedPageIds.has(pageId) && onMoveSelected) moveSelected("later");
                  else onMove(index, index + 1);
                }}
                onDragStart={(event) => {
                  setDraggedIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-croprotate-page", String(index));
                }}
                onDragOver={(event) => {
                  if (draggedIndex === null) return;
                  if (draggingSelectedBlock && selectedPageIds.has(pageId)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropIndex(index);
                }}
                onDrop={(event) => {
                  if (!Array.from(event.dataTransfer.types).includes("application/x-croprotate-page")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const from = draggedIndex ?? Number.parseInt(event.dataTransfer.getData("application/x-croprotate-page"), 10);
                  const movingSelection = Number.isInteger(from) && selectedCount > 1 && selectedPageIds.has(pageIds[from]) && onMoveSelected;
                  if (movingSelection) {
                    const insertionIndex = blockDropInsertion(pageIds, selectedPageIds, pageId);
                    if (insertionIndex !== null) onMoveSelected(orderedSelectedIds, insertionIndex);
                  } else if (Number.isInteger(from) && from !== index) {
                    onMove(from, index);
                  }
                  finishDrag();
                }}
                onDragEnd={finishDrag}
              />
            );
          })}
        </div>

        <footer className="organizer-footer">
          <p>Page changes affect only this working copy and reset crop/rotation undo history. Your original PDFs are never modified or uploaded.</p>
          <button type="button" className="primary-button" onClick={onClose} disabled={busy}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
