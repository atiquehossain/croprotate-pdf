import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  hitTestAnnotations,
  moveAnnotationInViewport,
  resizeAnnotationInViewport,
  sourcePointToViewport,
  viewportAnnotationBounds,
  viewportPointToSource,
} from "../../annotations/geometry";
import type { AnnotationViewportTransform } from "../../annotations/geometry";
import type {
  Annotation,
  AnnotationPoint,
  AnnotationRect,
  AnnotationStyle,
  AnnotationTool,
} from "../../annotations/types";

type WithoutIdentity<T> = T extends Annotation ? Omit<T, "id" | "pageId"> : never;
export type NewAnnotation = WithoutIdentity<Annotation>;

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type ShapeTool = "check" | "cross" | "line" | "arrow" | "rectangle" | "ellipse";

interface InkGesture {
  type: "ink";
  pointerId: number;
  tool: "pen" | "highlighter";
  points: AnnotationPoint[];
}

interface ShapeGesture {
  type: "shape";
  pointerId: number;
  tool: ShapeTool;
  start: AnnotationPoint;
  current: AnnotationPoint;
}

interface MoveGesture {
  type: "move";
  pointerId: number;
  annotation: Annotation;
  start: AnnotationPoint;
}

interface ResizeGesture {
  type: "resize";
  pointerId: number;
  annotation: Annotation;
  handle: ResizeHandle;
  bounds: AnnotationRect;
}

type Gesture = InkGesture | ShapeGesture | MoveGesture | ResizeGesture;

const RESIZE_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_LABELS: Record<ResizeHandle, string> = {
  nw: "Resize annotation from top left",
  n: "Resize annotation from top",
  ne: "Resize annotation from top right",
  e: "Resize annotation from right",
  se: "Resize annotation from bottom right",
  s: "Resize annotation from bottom",
  sw: "Resize annotation from bottom left",
  w: "Resize annotation from left",
};

const CREATION_LABELS: Record<Exclude<AnnotationTool, "select" | "eraser">, string> = {
  pen: "Freehand drawing",
  highlighter: "Highlight",
  text: "Text",
  date: "Date",
  check: "Check mark",
  cross: "Cross mark",
  line: "Line",
  arrow: "Arrow",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  signature: "Visual signature",
  initial: "Visual initials",
};

export interface AnnotationOverlayProps {
  annotations: readonly Annotation[];
  activeTool: AnnotationTool;
  style: AnnotationStyle;
  transform: AnnotationViewportTransform;
  /** Current rendered page dimensions in CSS pixels. */
  viewportWidth: number;
  viewportHeight: number;
  /** Current CSS pixels per physical PDF point. */
  pageScale: number;
  selectedId: string | null;
  cancelToken?: string;
  disabled?: boolean;
  onSelect: (annotationId: string | null) => void;
  onCreate: (annotation: NewAnnotation) => void;
  onUpdate: (annotation: Annotation) => void;
  onDelete: (annotationId: string) => void;
  onRequestText: (tool: "text" | "date", sourcePoint: AnnotationPoint) => void;
  onPlaceSignature: (kind: "signature" | "initial", sourcePoint: AnnotationPoint) => void;
  onStatus?: (message: string) => void;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizedPointFromEvent(
  event: Pick<PointerEvent, "clientX" | "clientY" | "pressure">,
  element: HTMLElement,
): AnnotationPoint {
  const bounds = element.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1)),
    y: clamp((event.clientY - bounds.top) / Math.max(bounds.height, 1)),
    ...(event.pressure > 0 ? { pressure: event.pressure } : {}),
  };
}

function viewportRect(first: AnnotationPoint, second: AnnotationPoint): AnnotationRect {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return { x, y, width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y) };
}

function viewportRectToSource(
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

function resizedBounds(
  original: AnnotationRect,
  point: AnnotationPoint,
  handle: ResizeHandle,
  minWidth: number,
  minHeight: number,
): AnnotationRect {
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  if (handle.includes("w")) left = Math.min(point.x, right - minWidth);
  if (handle.includes("e")) right = Math.max(point.x, left + minWidth);
  if (handle.includes("n")) top = Math.min(point.y, bottom - minHeight);
  if (handle.includes("s")) bottom = Math.max(point.y, top + minHeight);
  left = clamp(left);
  top = clamp(top);
  right = clamp(right);
  bottom = clamp(bottom);
  return { x: left, y: top, width: Math.max(minWidth, right - left), height: Math.max(minHeight, bottom - top) };
}

function expandTinyBounds(
  bounds: AnnotationRect,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationRect {
  const minWidth = 24 / Math.max(viewportWidth, 1);
  const minHeight = 24 / Math.max(viewportHeight, 1);
  const width = Math.max(bounds.width, minWidth);
  const height = Math.max(bounds.height, minHeight);
  return {
    x: clamp(bounds.x - (width - bounds.width) / 2, 0, 1 - width),
    y: clamp(bounds.y - (height - bounds.height) / 2, 0, 1 - height),
    width,
    height,
  };
}

function pointToPixels(point: AnnotationPoint, width: number, height: number): AnnotationPoint {
  return { ...point, x: point.x * width, y: point.y * height };
}

function pointsAttribute(points: readonly AnnotationPoint[], width: number, height: number): string {
  return points.map((point) => {
    const pixel = pointToPixels(point, width, height);
    return `${pixel.x},${pixel.y}`;
  }).join(" ");
}

function mappedRect(
  annotation: Annotation,
  transform: AnnotationViewportTransform,
  width: number,
  height: number,
): AnnotationRect {
  const rect = viewportAnnotationBounds(annotation, transform);
  return {
    x: rect.x * width,
    y: rect.y * height,
    width: rect.width * width,
    height: rect.height * height,
  };
}

function renderAnnotation(
  annotation: Annotation,
  transform: AnnotationViewportTransform,
  width: number,
  height: number,
  pageScale: number,
  markerId: string,
): ReactNode {
  const strokeWidth = Math.max(0.75, annotation.width * pageScale);
  const common = {
    stroke: annotation.color,
    strokeWidth,
    opacity: annotation.opacity,
    vectorEffect: "non-scaling-stroke" as const,
  };
  switch (annotation.kind) {
    case "ink": {
      return (
        <>
          {annotation.strokes.map((stroke, index) => {
            const points = stroke.map((point) => sourcePointToViewport(point, transform));
            if (points.length === 1) {
              const pixel = pointToPixels(points[0], width, height);
              return <circle key={index} cx={pixel.x} cy={pixel.y} r={strokeWidth / 2} fill={annotation.color} opacity={annotation.opacity} />;
            }
            return (
              <polyline
                key={index}
                {...common}
                points={pointsAttribute(points, width, height)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </>
      );
    }
    case "highlight": {
      const points = annotation.points.map((point) => sourcePointToViewport(point, transform));
      if (points.length === 1) {
        const pixel = pointToPixels(points[0], width, height);
        return <circle cx={pixel.x} cy={pixel.y} r={strokeWidth / 2} fill={annotation.color} opacity={annotation.opacity} />;
      }
      return (
        <polyline
          {...common}
          points={pointsAttribute(points, width, height)}
          fill="none"
          strokeLinecap="square"
          strokeLinejoin="round"
          style={{ mixBlendMode: "multiply" }}
        />
      );
    }
    case "line": {
      const start = pointToPixels(sourcePointToViewport(annotation.start, transform), width, height);
      const end = pointToPixels(sourcePointToViewport(annotation.end, transform), width, height);
      return (
        <>
          {annotation.tool === "arrow" && (
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={annotation.color} opacity={annotation.opacity} />
              </marker>
            </defs>
          )}
          <line {...common} x1={start.x} y1={start.y} x2={end.x} y2={end.y} strokeLinecap="round" markerEnd={annotation.tool === "arrow" ? `url(#${markerId})` : undefined} />
        </>
      );
    }
    case "shape": {
      const rect = mappedRect(annotation, transform, width, height);
      const fill = annotation.fillColor ?? "none";
      const fillOpacity = annotation.fillOpacity ?? 0;
      return annotation.tool === "rectangle" ? (
        <rect {...common} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={Math.min(4, rect.width / 8, rect.height / 8)} fill={fill} fillOpacity={fillOpacity} />
      ) : (
        <ellipse {...common} cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={rect.width / 2} ry={rect.height / 2} fill={fill} fillOpacity={fillOpacity} />
      );
    }
    case "mark": {
      const rect = mappedRect(annotation, transform, width, height);
      const px = (x: number) => rect.x + x * rect.width;
      const py = (y: number) => rect.y + y * rect.height;
      return annotation.tool === "check" ? (
        <polyline {...common} points={`${px(0.1)},${py(0.52)} ${px(0.39)},${py(0.84)} ${px(0.92)},${py(0.12)}`} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <g {...common} fill="none" strokeLinecap="round">
          <line x1={px(0.13)} y1={py(0.13)} x2={px(0.87)} y2={py(0.87)} />
          <line x1={px(0.87)} y1={py(0.13)} x2={px(0.13)} y2={py(0.87)} />
        </g>
      );
    }
    case "text": {
      const rect = mappedRect(annotation, transform, width, height);
      const fontSize = Math.max(6, annotation.fontSize * pageScale);
      return (
        <foreignObject x={rect.x} y={rect.y} width={Math.max(rect.width, 1)} height={Math.max(rect.height, fontSize * 1.25)} opacity={annotation.opacity}>
          <div
            className={`annotation-rendered-text font-${annotation.fontFamily ?? "sans-serif"}`}
            style={{
              color: annotation.color,
              fontSize: `${fontSize}px`,
              lineHeight: 1.2,
              textAlign: annotation.align ?? "left",
            }}
          >
            {annotation.text}
          </div>
        </foreignObject>
      );
    }
  }
}

function draftShapeAnnotation(
  gesture: ShapeGesture,
  style: AnnotationStyle,
  transform: AnnotationViewportTransform,
  viewportWidth: number,
  viewportHeight: number,
): NewAnnotation | null {
  const dx = (gesture.current.x - gesture.start.x) * viewportWidth;
  const dy = (gesture.current.y - gesture.start.y) * viewportHeight;
  const distance = Math.hypot(dx, dy);
  if (gesture.tool === "line" || gesture.tool === "arrow") {
    if (distance < 4) return null;
    return {
      kind: "line",
      tool: gesture.tool,
      start: viewportPointToSource(gesture.start, transform),
      end: viewportPointToSource(gesture.current, transform),
      ...style,
      label: CREATION_LABELS[gesture.tool],
    };
  }

  let rect = viewportRect(gesture.start, gesture.current);
  if (distance < 4) {
    const defaultWidth = 28 / Math.max(viewportWidth, 1);
    const defaultHeight = 28 / Math.max(viewportHeight, 1);
    rect = {
      x: clamp(gesture.start.x - defaultWidth / 2, 0, 1 - defaultWidth),
      y: clamp(gesture.start.y - defaultHeight / 2, 0, 1 - defaultHeight),
      width: defaultWidth,
      height: defaultHeight,
    };
  }
  const sourceRect = viewportRectToSource(rect, transform);
  if (gesture.tool === "check" || gesture.tool === "cross") {
    return { kind: "mark", tool: gesture.tool, rect: sourceRect, ...style, label: CREATION_LABELS[gesture.tool] };
  }
  return { kind: "shape", tool: gesture.tool, rect: sourceRect, ...style, label: CREATION_LABELS[gesture.tool] };
}

export function AnnotationOverlay({
  annotations,
  activeTool,
  style,
  transform,
  viewportWidth,
  viewportHeight,
  pageScale,
  selectedId,
  cancelToken = "",
  disabled = false,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onRequestText,
  onPlaceSignature,
  onStatus,
}: AnnotationOverlayProps) {
  const markerPrefix = useId().replace(/:/g, "");
  const overlayRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [previewSelection, setPreviewSelection] = useState<Annotation | null>(null);

  const selected = annotations.find(({ id }) => id === selectedId) ?? null;
  const renderedAnnotations = useMemo(
    () => previewSelection
      ? annotations.map((annotation) => annotation.id === previewSelection.id ? previewSelection : annotation)
      : annotations,
    [annotations, previewSelection],
  );
  const visibleSelected = previewSelection ?? selected;
  const rawSelectionBounds = visibleSelected
    ? viewportAnnotationBounds(visibleSelected, transform)
    : null;
  const selectionBounds = rawSelectionBounds
    ? expandTinyBounds(rawSelectionBounds, viewportWidth, viewportHeight)
    : null;

  useEffect(() => {
    setGesture(null);
    setPreviewSelection(null);
  }, [cancelToken]);

  useEffect(() => {
    if (!gesture) setPreviewSelection(null);
  }, [annotations, gesture]);

  const status = (message: string) => onStatus?.(message);

  const beginGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || !overlayRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    overlayRef.current.focus({ preventScroll: true });
    const point = normalizedPointFromEvent(event.nativeEvent, overlayRef.current);

    if (activeTool === "select" || activeTool === "eraser") {
      const hit = hitTestAnnotations(annotations, point, transform, { tolerance: 10 / Math.max(Math.min(viewportWidth, viewportHeight), 1) })[0];
      if (!hit) {
        onSelect(null);
        return;
      }
      if (activeTool === "eraser") {
        onDelete(hit.id);
        status(`${hit.label ?? "Annotation"} removed.`);
        return;
      }
      onSelect(hit.id);
      event.currentTarget.setPointerCapture(event.pointerId);
      setGesture({ type: "move", pointerId: event.pointerId, annotation: hit, start: point });
      setPreviewSelection(hit);
      return;
    }

    if (activeTool === "text" || activeTool === "date") {
      onRequestText(activeTool, viewportPointToSource(point, transform));
      return;
    }
    if (activeTool === "signature" || activeTool === "initial") {
      onPlaceSignature(activeTool, viewportPointToSource(point, transform));
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    if (activeTool === "pen" || activeTool === "highlighter") {
      setGesture({
        type: "ink",
        pointerId: event.pointerId,
        tool: activeTool,
        points: [viewportPointToSource(point, transform)],
      });
      return;
    }
    setGesture({ type: "shape", pointerId: event.pointerId, tool: activeTool, start: point, current: point });
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId || !overlayRef.current) return;
    event.preventDefault();
    const point = normalizedPointFromEvent(event.nativeEvent, overlayRef.current);
    if (gesture.type === "ink") {
      const events = typeof event.nativeEvent.getCoalescedEvents === "function"
        ? event.nativeEvent.getCoalescedEvents()
        : [event.nativeEvent];
      const next = events.map((item) => viewportPointToSource(normalizedPointFromEvent(item, overlayRef.current!), transform));
      setGesture((current) => {
        if (!current || current.type !== "ink") return current;
        const points = [...current.points];
        for (const item of next) {
          const previous = points[points.length - 1];
          if (!previous || Math.hypot(item.x - previous.x, item.y - previous.y) >= 0.00025) points.push(item);
        }
        return { ...current, points };
      });
    } else if (gesture.type === "shape") {
      setGesture({ ...gesture, current: point });
    } else if (gesture.type === "move") {
      setPreviewSelection(moveAnnotationInViewport(
        gesture.annotation,
        { x: point.x - gesture.start.x, y: point.y - gesture.start.y },
        transform,
      ));
    } else {
      const nextBounds = resizedBounds(
        gesture.bounds,
        point,
        gesture.handle,
        12 / Math.max(viewportWidth, 1),
        12 / Math.max(viewportHeight, 1),
      );
      setPreviewSelection(resizeAnnotationInViewport(gesture.annotation, nextBounds, transform));
    }
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (gesture.type === "ink") {
      if (gesture.points.length > 0) {
        onCreate(gesture.tool === "pen"
          ? { kind: "ink", tool: "pen", strokes: [gesture.points], ...style, label: CREATION_LABELS.pen }
          : { kind: "highlight", tool: "highlighter", points: gesture.points, ...style, label: CREATION_LABELS.highlighter });
      }
    } else if (gesture.type === "shape") {
      const draft = draftShapeAnnotation(gesture, style, transform, viewportWidth, viewportHeight);
      if (draft) onCreate(draft);
      else status("Draw a slightly larger line.");
    } else if (previewSelection) {
      onUpdate(previewSelection);
    }
    setGesture(null);
    setPreviewSelection(null);
  };

  const cancelGesture = () => {
    if (!gesture) return;
    setGesture(null);
    setPreviewSelection(null);
    status("Annotation gesture cancelled.");
  };

  const beginResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    handle: ResizeHandle,
  ) => {
    if (disabled || !selected || !overlayRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    overlayRef.current.setPointerCapture(event.pointerId);
    setGesture({
      type: "resize",
      pointerId: event.pointerId,
      annotation: selected,
      handle,
      bounds: viewportAnnotationBounds(selected, transform),
    });
    setPreviewSelection(selected);
  };

  const beginSelectedMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || activeTool !== "select" || !selected || !overlayRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = normalizedPointFromEvent(event.nativeEvent, overlayRef.current);
    overlayRef.current.setPointerCapture(event.pointerId);
    setGesture({ type: "move", pointerId: event.pointerId, annotation: selected, start: point });
    setPreviewSelection(selected);
  };

  const keyboardMove = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!selected || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const points = event.shiftKey ? 10 : 1;
    const x = event.key === "ArrowLeft" ? -points * pageScale / Math.max(viewportWidth, 1)
      : event.key === "ArrowRight" ? points * pageScale / Math.max(viewportWidth, 1)
        : 0;
    const y = event.key === "ArrowUp" ? -points * pageScale / Math.max(viewportHeight, 1)
      : event.key === "ArrowDown" ? points * pageScale / Math.max(viewportHeight, 1)
        : 0;
    onUpdate(moveAnnotationInViewport(selected, { x, y }, transform));
  };

  const keyboardResize = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    handle: ResizeHandle,
  ) => {
    if (!selected || !rawSelectionBounds || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if ((horizontal && !/[we]/.test(handle)) || (!horizontal && !/[ns]/.test(handle))) return;
    event.preventDefault();
    event.stopPropagation();
    const points = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -points * pageScale / Math.max(viewportWidth, 1)
      : event.key === "ArrowRight" ? points * pageScale / Math.max(viewportWidth, 1)
        : 0;
    const dy = event.key === "ArrowUp" ? -points * pageScale / Math.max(viewportHeight, 1)
      : event.key === "ArrowDown" ? points * pageScale / Math.max(viewportHeight, 1)
        : 0;
    const point = {
      x: handle.includes("w") ? rawSelectionBounds.x + dx
        : handle.includes("e") ? rawSelectionBounds.x + rawSelectionBounds.width + dx
          : rawSelectionBounds.x + rawSelectionBounds.width / 2,
      y: handle.includes("n") ? rawSelectionBounds.y + dy
        : handle.includes("s") ? rawSelectionBounds.y + rawSelectionBounds.height + dy
          : rawSelectionBounds.y + rawSelectionBounds.height / 2,
    };
    const next = resizedBounds(
      rawSelectionBounds,
      point,
      handle,
      pageScale / Math.max(viewportWidth, 1),
      pageScale / Math.max(viewportHeight, 1),
    );
    onUpdate(resizeAnnotationInViewport(selected, next, transform));
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (gesture) cancelGesture();
      else onSelect(null);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      onDelete(selectedId);
      return;
    }
    keyboardMove(event);
  };

  const draftInk = gesture?.type === "ink"
    ? gesture.points.map((point) => sourcePointToViewport(point, transform))
    : null;
  const draftShape = gesture?.type === "shape"
    ? draftShapeAnnotation(gesture, style, transform, viewportWidth, viewportHeight)
    : null;
  const cursorClass = activeTool === "select" ? "is-selecting"
    : activeTool === "eraser" ? "is-erasing"
      : activeTool === "text" || activeTool === "date" || activeTool === "signature" || activeTool === "initial" ? "is-placing"
        : "is-drawing";

  return (
    <div
      ref={overlayRef}
      className={`annotation-overlay ${cursorClass}${disabled ? " is-disabled" : ""}`}
      data-tool={activeTool}
      tabIndex={disabled ? -1 : 0}
      role="group"
      aria-label={`Page annotations. ${CREATION_LABELS[activeTool as Exclude<AnnotationTool, "select" | "eraser">] ?? (activeTool === "select" ? "Select mode" : "Eraser mode")}.`}
      onPointerDown={beginGesture}
      onPointerMove={moveGesture}
      onPointerUp={finishGesture}
      onPointerCancel={cancelGesture}
      onKeyDown={keyDown}
    >
      <svg
        className="annotation-canvas"
        viewBox={`0 0 ${Math.max(1, viewportWidth)} ${Math.max(1, viewportHeight)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {renderedAnnotations.map((annotation, index) => (
          <g key={annotation.id} className={annotation.id === selectedId ? "is-selected" : undefined}>
            {renderAnnotation(annotation, transform, viewportWidth, viewportHeight, pageScale, `${markerPrefix}-arrow-${index}`)}
          </g>
        ))}
        {draftInk && draftInk.length > 0 && (
          <polyline
            className="annotation-draft-stroke"
            points={pointsAttribute(draftInk, viewportWidth, viewportHeight)}
            fill="none"
            stroke={style.color}
            strokeWidth={Math.max(0.75, style.width * pageScale)}
            strokeOpacity={style.opacity}
            strokeLinecap={gesture?.type === "ink" && gesture.tool === "highlighter" ? "square" : "round"}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {draftShape && (
          <g className="annotation-draft-shape">
            {renderAnnotation(
              { ...draftShape, id: "draft", pageId: "draft" } as Annotation,
              transform,
              viewportWidth,
              viewportHeight,
              pageScale,
              `${markerPrefix}-draft-arrow`,
            )}
          </g>
        )}
      </svg>

      {selected && selectionBounds && activeTool === "select" && (
        <div
          className={`annotation-selection${gesture ? " is-dragging" : ""}`}
          style={{
            left: `${selectionBounds.x * 100}%`,
            top: `${selectionBounds.y * 100}%`,
            width: `${selectionBounds.width * 100}%`,
            height: `${selectionBounds.height * 100}%`,
          }}
          role="group"
          tabIndex={0}
          aria-label={`${selected.label ?? "Selected annotation"}. Drag to move; use arrow keys for precise movement.`}
          onPointerDown={beginSelectedMove}
          onKeyDown={keyboardMove}
        >
          <span className="annotation-selection-label" aria-hidden="true">{selected.label ?? selected.tool}</span>
          {RESIZE_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className={`annotation-resize-handle handle-${handle}`}
              aria-label={HANDLE_LABELS[handle]}
              disabled={disabled}
              onPointerDown={(event) => beginResize(event, handle)}
              onKeyDown={(event) => keyboardResize(event, handle)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
