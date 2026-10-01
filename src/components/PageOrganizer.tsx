import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Download,
  FilePlus2,
  GripVertical,
  Trash2,
  X,
} from "lucide-react";
import type { PageEdit, PageInfo } from "../types";
import type { PdfEngine } from "../pdf/engine";
import { totalRotation, visualPageDimensions } from "../pdf/geometry";

interface OrganizerThumbnailProps {
  engine: PdfEngine;
  info: PageInfo;
  edit: PageEdit;
  pageId: string;
  position: number;
  pageCount: number;
  active: boolean;
  selected: boolean;
  busy: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onActivate: () => void;
  onToggle: () => void;
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
  pageCount,
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
    const frame = window.requestAnimationFrame(() => {
      try {
        const rotation = totalRotation(info, edit.rotation);
        const [width, height] = visualPageDimensions(info, rotation);
        const scale = Math.min(164 / width, 190 / height, 0.38);
        const rendered = engine.renderPage(info.index, edit.rotation, scale, true);
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
    });
    return () => {
      cancelled = true;
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
            onChange={onToggle}
            aria-label={`Select page ${position + 1}`}
          />
          <span>{position + 1}</span>
        </label>
        <span className="organizer-drag-hint" title="Drag to reorder" aria-hidden="true">
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

      <div className="organizer-move-controls" aria-label={`Move page ${position + 1}`}>
        <button
          type="button"
          onClick={onMoveEarlier}
          disabled={busy || position === 0}
          aria-label={`Move page ${position + 1} earlier`}
          title="Move earlier"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          onClick={onMoveLater}
          disabled={busy || position + 1 >= pageCount}
          aria-label={`Move page ${position + 1} later`}
          title="Move later"
        >
          <ArrowRight size={16} />
        </button>
      </div>
    </article>
  );
}

interface PageOrganizerProps {
  engine: PdfEngine;
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
  onSelectAll: () => void;
  onClearSelection: () => void;
  onMove: (from: number, to: number) => void;
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
  onSelectAll,
  onClearSelection,
  onMove,
  onAddPdf,
  onExtract,
  onDelete,
  onDialogKeyDown,
}: PageOrganizerProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const selectedCount = selectedPageIds.size;

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

  return (
    <div className="modal-backdrop organizer-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="page-organizer"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="organizer-title"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="organizer-header">
          <div>
            <span className="eyebrow">Private page tools</span>
            <h2 id="organizer-title">Organize pages</h2>
            <p>Merge, reorder, remove, or extract pages. Everything stays in this tab.</p>
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
          <span className="organizer-selection" role="status" aria-live="polite">
            {selectedCount ? `${selectedCount} selected` : "Select pages for extract or remove"}
          </span>
          <button type="button" className="organizer-action" onClick={onSelectAll} disabled={busy || selectedCount === pages.length}>
            <CheckCheck size={17} /> Select all
          </button>
          <button type="button" className="organizer-action" onClick={onClearSelection} disabled={busy || selectedCount === 0}>
            Clear
          </button>
          <span className="organizer-toolbar-spacer" />
          <button type="button" className="organizer-action" onClick={onExtract} disabled={busy || selectedCount === 0}>
            <Download size={17} /> Extract selected
          </button>
          <button
            type="button"
            className="organizer-action is-danger"
            onClick={onDelete}
            disabled={busy || selectedCount === 0 || selectedCount >= pages.length}
            title={selectedCount >= pages.length ? "Keep at least one page" : "Remove selected pages"}
          >
            <Trash2 size={17} /> Remove selected
          </button>
        </div>

        <p className="organizer-operation-status" role="status" aria-live="polite">{status}</p>

        <div className="organizer-grid" role="list" aria-label={`${pages.length} document pages`}>
          {pages.map((page, index) => {
            const pageId = pageIds[index];
            return (
              <OrganizerThumbnail
                key={pageId}
                engine={engine}
                info={page}
                edit={edits[index]}
                pageId={pageId}
                position={index}
                pageCount={pages.length}
                active={index === activePage}
                selected={selectedPageIds.has(pageId)}
                busy={busy}
                dragging={draggedIndex === index}
                dropTarget={dropIndex === index && draggedIndex !== index}
                onActivate={() => onActivate(index)}
                onToggle={() => onToggleSelected(pageId)}
                onMoveEarlier={() => onMove(index, index - 1)}
                onMoveLater={() => onMove(index, index + 1)}
                onDragStart={(event) => {
                  setDraggedIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-croprotate-page", String(index));
                }}
                onDragOver={(event) => {
                  if (draggedIndex === null) return;
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
                  if (Number.isInteger(from) && from !== index) onMove(from, index);
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
