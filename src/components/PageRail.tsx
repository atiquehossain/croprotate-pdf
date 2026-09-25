import { useEffect, useRef, useState } from "react";
import type { PageEdit, PageInfo } from "../types";
import type { PdfEngine } from "../pdf/engine";
import { totalRotation, visualPageDimensions } from "../pdf/geometry";

interface ThumbnailProps {
  engine: PdfEngine;
  info: PageInfo;
  edit: PageEdit;
  active: boolean;
  onSelect: () => void;
}

function Thumbnail({ engine, info, edit, active, onSelect }: ThumbnailProps) {
  const rootRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Unmount off-screen canvases so long documents do not retain every
        // thumbnail backing store after the user scrolls through the rail.
        setVisible(active || entry.isIntersecting);
      },
      { rootMargin: "180px" },
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
        const scale = Math.min(132 / width, 156 / height, 0.32);
        const rendered = engine.renderPage(info.index, edit.rotation, scale, true);
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        context.putImageData(new ImageData(rendered.pixels, rendered.width, rendered.height), 0, 0);
      } catch {
        // The numbered placeholder remains usable if a thumbnail cannot render.
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [edit.rotation, engine, info, visible]);

  return (
    <button
      ref={rootRef}
      type="button"
      className={`thumbnail ${active ? "is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={`Show page ${info.index + 1}`}
      onClick={onSelect}
    >
      <span className="thumbnail-paper">
        {visible ? <canvas ref={canvasRef} aria-hidden="true" /> : <span>{info.index + 1}</span>}
      </span>
      <span className="thumbnail-label">{info.label}</span>
    </button>
  );
}

interface PageRailProps {
  engine: PdfEngine;
  pages: PageInfo[];
  edits: PageEdit[];
  activePage: number;
  onSelect: (index: number) => void;
}

export function PageRail({ engine, pages, edits, activePage, onSelect }: PageRailProps) {
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [activePage]);

  return (
    <aside className="page-rail" aria-label="Document pages">
      <div className="rail-heading">
        <span>Pages</span>
        <strong>{pages.length}</strong>
      </div>
      <div className="thumbnail-list" ref={activeRef}>
        {pages.map((page, index) => (
          <Thumbnail
            key={page.index}
            engine={engine}
            info={page}
            edit={edits[index]}
            active={index === activePage}
            onSelect={() => onSelect(index)}
          />
        ))}
      </div>
    </aside>
  );
}
