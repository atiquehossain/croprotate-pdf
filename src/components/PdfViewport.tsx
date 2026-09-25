import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import type { PageEdit, PageInfo, VisualRect } from "../types";
import type { PdfEngine } from "../pdf/engine";
import { totalRotation, visualPageDimensions } from "../pdf/geometry";
import { CropOverlay } from "./CropOverlay";

interface PdfViewportProps {
  engine: PdfEngine;
  pageInfo: PageInfo;
  pageEdit: PageEdit;
  pageIndex: number;
  pageCount: number;
  visualCrop: VisualRect;
  normalizedAspect: number | null;
  zoom: number;
  busy: boolean;
  onZoomChange: (zoom: number) => void;
  onCropCommit: (rect: VisualRect) => void;
  onCropReset: () => void;
  onPageChange: (index: number) => void;
  onStatus: (message: string) => void;
}

interface Size {
  width: number;
  height: number;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return isEditableTarget(target)
    || target.isContentEditable
    || target.closest("button, a, [role='button'], [role='tab']") !== null;
}

export function PdfViewport({
  engine,
  pageInfo,
  pageEdit,
  pageIndex,
  pageCount,
  visualCrop,
  normalizedAspect,
  zoom,
  busy,
  onZoomChange,
  onCropCommit,
  onCropReset,
  onPageChange,
  onStatus,
}: PdfViewportProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 900, height: 700 });
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const rotation = totalRotation(pageInfo, pageEdit.rotation);
  const [pageWidthPoints, pageHeightPoints] = useMemo(
    () => visualPageDimensions(pageInfo, rotation),
    [pageInfo, rotation],
  );
  const fitScale = Math.max(
    0.05,
    Math.min(
      Math.max(size.width - 72, 160) / pageWidthPoints,
      Math.max(size.height - 112, 160) / pageHeightPoints,
      2.5,
    ),
  );
  const cssScale = fitScale * zoom;
  const cssWidth = pageWidthPoints * cssScale;
  const cssHeight = pageHeightPoints * cssScale;

  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isInteractiveTarget(event.target)) {
        setSpacePressed(true);
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePressed(false);
    };
    const blur = () => setSpacePressed(false);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      onZoomChange(Math.min(Math.max(zoom * factor, 0.5), 4));
    };
    scroller.addEventListener("wheel", handleWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", handleWheel);
  }, [onZoomChange, zoom]);

  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      setRendering(true);
      setRenderError(null);
      try {
        const deviceScale = window.devicePixelRatio || 1;
        const maxScale = 3200 / Math.max(pageWidthPoints, pageHeightPoints);
        const renderScale = Math.min(cssScale * deviceScale, maxScale, 5);
        const rendered = engine.renderPage(pageIndex, pageEdit.rotation, renderScale, true);
        if (cancelled) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("Your browser could not create the preview canvas.");
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        context.putImageData(
          new ImageData(rendered.pixels, rendered.width, rendered.height),
          0,
          0,
        );
        setRendering(false);
      } catch (error) {
        if (!cancelled) {
          setRendering(false);
          setRenderError(error instanceof Error ? error.message : String(error));
        }
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [cssScale, engine, pageEdit.rotation, pageHeightPoints, pageIndex, pageWidthPoints]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressed);
    if (!shouldPan || !scrollRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const scroller = scrollRef.current;
    scroller.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
    };
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const scroller = scrollRef.current;
    if (!pan || !scroller || pan.pointerId !== event.pointerId) return;
    scroller.scrollLeft = pan.left - (event.clientX - pan.x);
    scroller.scrollTop = pan.top - (event.clientY - pan.y);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  };

  const cancelToken = `${pageIndex}:${pageEdit.rotation}:${Math.round(cssWidth)}:${Math.round(cssHeight)}`;

  return (
    <section className="viewer" aria-label="PDF preview" ref={shellRef}>
      <div className="viewer-topbar">
        <div className="mobile-page-nav" aria-label="Page navigation">
          <button
            type="button"
            className="icon-button compact"
            aria-label="Previous page"
            disabled={pageIndex === 0}
            onClick={() => onPageChange(pageIndex - 1)}
          >
            ‹
          </button>
          <span>
            {pageIndex + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="icon-button compact"
            aria-label="Next page"
            disabled={pageIndex + 1 >= pageCount}
            onClick={() => onPageChange(pageIndex + 1)}
          >
            ›
          </button>
        </div>
        <span className="viewer-hint">Drag to crop · inside moves · handles resize</span>
        <div className="zoom-controls" aria-label="Zoom controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => onZoomChange(Math.max(0.5, zoom / 1.25))}
          >
            <Minus size={17} />
          </button>
          <output aria-label="Current zoom">{Math.round(zoom * 100)}%</output>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => onZoomChange(Math.min(4, zoom * 1.25))}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="fit-button"
            onClick={() => onZoomChange(1)}
          >
            <Scan size={16} />
            Fit
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`viewer-scroll ${spacePressed ? "is-pan-ready" : ""}`}
        onPointerDownCapture={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className="page-stage"
          style={{
            width: `${Math.max(cssWidth + 64, size.width)}px`,
            height: `${Math.max(cssHeight + 64, size.height - 48)}px`,
          }}
        >
          <div
            className="page-surface"
            style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
          >
            <canvas
              ref={canvasRef}
              className="page-canvas"
              style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
              aria-label={`Rendered preview of page ${pageIndex + 1}`}
            />
            {!renderError && (
              <CropOverlay
                rect={visualCrop}
                hasCrop={pageEdit.crop !== null}
                lockedAspect={normalizedAspect}
                pageWidthPoints={pageWidthPoints}
                pageHeightPoints={pageHeightPoints}
                cancelToken={cancelToken}
                disabled={busy || rendering}
                onCommit={onCropCommit}
                onReset={onCropReset}
                onStatus={onStatus}
              />
            )}
            {rendering && <div className="canvas-state">Rendering page…</div>}
            {renderError && (
              <div className="canvas-state error" role="alert">
                Preview unavailable
                <small>{renderError}</small>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="viewer-footer">
        <span>Ctrl/⌘ + wheel zooms</span>
        <span>Space or middle-drag pans</span>
        <span>Arrow keys nudge crop</span>
      </div>
    </section>
  );
}
