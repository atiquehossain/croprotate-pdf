import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { VisualRect } from "../types";
import { clamp } from "../pdf/geometry";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type DragMode = "new" | "move" | "resize";

interface DragState {
  pointerId: number;
  mode: DragMode;
  handle: Handle | null;
  startPoint: [number, number];
  startRect: VisualRect;
}

interface CropOverlayProps {
  rect: VisualRect;
  hasCrop: boolean;
  lockedAspect: number | null;
  pageWidthPoints: number;
  pageHeightPoints: number;
  cancelToken: string;
  disabled?: boolean;
  onCommit: (rect: VisualRect) => void;
  onReset: () => void;
  onStatus: (message: string) => void;
}

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const HANDLE_LABELS: Record<Handle, string> = {
  nw: "Top-left crop handle",
  n: "Top crop handle",
  ne: "Top-right crop handle",
  e: "Right crop handle",
  se: "Bottom-right crop handle",
  s: "Bottom crop handle",
  sw: "Bottom-left crop handle",
  w: "Left crop handle",
};

function pointFromEvent(
  event: ReactPointerEvent<HTMLElement>,
  element: HTMLElement,
): [number, number] {
  const bounds = element.getBoundingClientRect();
  return [
    clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1)),
    clamp((event.clientY - bounds.top) / Math.max(bounds.height, 1)),
  ];
}

function moveRect(rect: VisualRect, point: [number, number], start: [number, number]): VisualRect {
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];
  const left = clamp(rect[0] + point[0] - start[0], 0, 1 - width);
  const top = clamp(rect[1] + point[1] - start[1], 0, 1 - height);
  return [left, top, left + width, top + height];
}

function newRect(
  start: [number, number],
  point: [number, number],
  ratio: number | null,
): VisualRect {
  if (ratio === null) {
    return [
      Math.min(start[0], point[0]),
      Math.min(start[1], point[1]),
      Math.max(start[0], point[0]),
      Math.max(start[1], point[1]),
    ];
  }
  const signX = point[0] >= start[0] ? 1 : -1;
  const signY = point[1] >= start[1] ? 1 : -1;
  let width = Math.abs(point[0] - start[0]);
  let height = Math.abs(point[1] - start[1]);
  if (height === 0 || width / height > ratio) height = width / ratio;
  else width = height * ratio;
  width = Math.min(width, signX > 0 ? 1 - start[0] : start[0]);
  height = Math.min(height, signY > 0 ? 1 - start[1] : start[1]);
  if (width / Math.max(height, 1e-9) > ratio) width = height * ratio;
  else height = width / ratio;
  const endX = start[0] + signX * width;
  const endY = start[1] + signY * height;
  return [Math.min(start[0], endX), Math.min(start[1], endY), Math.max(start[0], endX), Math.max(start[1], endY)];
}

function resizeRect(
  start: VisualRect,
  point: [number, number],
  handle: Handle,
  ratio: number | null,
  minWidth: number,
  minHeight: number,
): VisualRect {
  let [left, top, right, bottom] = start;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");

  if (west) left = Math.min(point[0], right - minWidth);
  if (east) right = Math.max(point[0], left + minWidth);
  if (north) top = Math.min(point[1], bottom - minHeight);
  if (south) bottom = Math.max(point[1], top + minHeight);
  left = clamp(left);
  top = clamp(top);
  right = clamp(right);
  bottom = clamp(bottom);

  if (ratio === null) return [left, top, right, bottom];

  if ((west || east) && (north || south)) {
    const anchorX = west ? start[2] : start[0];
    const anchorY = north ? start[3] : start[1];
    const signX = west ? -1 : 1;
    const signY = north ? -1 : 1;
    let width = Math.max(Math.abs(point[0] - anchorX), minWidth);
    let height = Math.max(Math.abs(point[1] - anchorY), minHeight);
    if (width / height > ratio) height = width / ratio;
    else width = height * ratio;
    width = Math.min(width, signX > 0 ? 1 - anchorX : anchorX);
    height = Math.min(height, signY > 0 ? 1 - anchorY : anchorY);
    if (width / Math.max(height, 1e-9) > ratio) width = height * ratio;
    else height = width / ratio;
    const edgeX = anchorX + signX * width;
    const edgeY = anchorY + signY * height;
    return [Math.min(anchorX, edgeX), Math.min(anchorY, edgeY), Math.max(anchorX, edgeX), Math.max(anchorY, edgeY)];
  }

  if (west || east) {
    const width = Math.max(right - left, minWidth);
    const centerY = (start[1] + start[3]) / 2;
    let height = Math.max(width / ratio, minHeight);
    height = Math.min(height, 2 * Math.min(centerY, 1 - centerY));
    const adjustedWidth = height * ratio;
    if (west) left = right - adjustedWidth;
    else right = left + adjustedWidth;
    top = centerY - height / 2;
    bottom = centerY + height / 2;
  } else {
    const height = Math.max(bottom - top, minHeight);
    const centerX = (start[0] + start[2]) / 2;
    let width = Math.max(height * ratio, minWidth);
    width = Math.min(width, 2 * Math.min(centerX, 1 - centerX));
    const adjustedHeight = width / ratio;
    if (north) top = bottom - adjustedHeight;
    else bottom = top + adjustedHeight;
    left = centerX - width / 2;
    right = centerX + width / 2;
  }
  return [clamp(left), clamp(top), clamp(right), clamp(bottom)];
}

export function CropOverlay({
  rect,
  hasCrop,
  lockedAspect,
  pageWidthPoints,
  pageHeightPoints,
  cancelToken,
  disabled = false,
  onCommit,
  onReset,
  onStatus,
}: CropOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draft, setDraft] = useState<VisualRect | null>(null);
  const visibleRect = draft ?? rect;

  useEffect(() => {
    setDrag(null);
    setDraft(null);
  }, [cancelToken]);

  useEffect(() => {
    if (!drag) setDraft(null);
  }, [rect, drag]);

  const style = useMemo(
    () => ({
      left: `${visibleRect[0] * 100}%`,
      top: `${visibleRect[1] * 100}%`,
      width: `${(visibleRect[2] - visibleRect[0]) * 100}%`,
      height: `${(visibleRect[3] - visibleRect[1]) * 100}%`,
    }),
    [visibleRect],
  );

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    mode: DragMode,
    handle: Handle | null = null,
  ) => {
    if (disabled || !overlayRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startPoint = pointFromEvent(event, overlayRef.current);
    const startRect = mode === "new" ? [startPoint[0], startPoint[1], startPoint[0], startPoint[1]] as VisualRect : rect;
    overlayRef.current.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, mode, handle, startPoint, startRect });
    setDraft(startRect);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || !overlayRef.current || event.pointerId !== drag.pointerId) return;
    const point = pointFromEvent(event, overlayRef.current);
    const bounds = overlayRef.current.getBoundingClientRect();
    const minWidth = 10 / Math.max(bounds.width, 1);
    const minHeight = 10 / Math.max(bounds.height, 1);
    if (drag.mode === "new") {
      setDraft(newRect(drag.startPoint, point, lockedAspect));
    } else if (drag.mode === "move") {
      setDraft(moveRect(drag.startRect, point, drag.startPoint));
    } else if (drag.handle) {
      setDraft(
        resizeRect(
          drag.startRect,
          point,
          drag.handle,
          lockedAspect,
          minWidth,
          minHeight,
        ),
      );
    }
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const result = draft;
    setDrag(null);
    setDraft(null);
    if (!result) return;
    const bounds = overlayRef.current?.getBoundingClientRect();
    const width = (result[2] - result[0]) * (bounds?.width ?? 0);
    const height = (result[3] - result[1]) * (bounds?.height ?? 0);
    if (width < 10 || height < 10) {
      onStatus("Crop ignored — draw a larger selection.");
      return;
    }
    onCommit(result);
  };

  const cancel = () => {
    if (!drag) return;
    setDrag(null);
    setDraft(null);
    onStatus("Crop gesture cancelled.");
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const points = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -points / pageWidthPoints : event.key === "ArrowRight" ? points / pageWidthPoints : 0;
    const dy = event.key === "ArrowUp" ? -points / pageHeightPoints : event.key === "ArrowDown" ? points / pageHeightPoints : 0;
    onCommit(moveRect(rect, [rect[0] + dx, rect[1] + dy], [rect[0], rect[1]]));
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, handle: Handle) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const horizontalHandle = handle.includes("w") || handle.includes("e");
    const verticalHandle = handle.includes("n") || handle.includes("s");
    const horizontalKey = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if ((horizontalKey && !horizontalHandle) || (!horizontalKey && !verticalHandle)) return;

    const points = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -points / pageWidthPoints : event.key === "ArrowRight" ? points / pageWidthPoints : 0;
    const dy = event.key === "ArrowUp" ? -points / pageHeightPoints : event.key === "ArrowDown" ? points / pageHeightPoints : 0;
    const point: [number, number] = [
      handle.includes("w") ? rect[0] + dx : handle.includes("e") ? rect[2] + dx : (rect[0] + rect[2]) / 2,
      handle.includes("n") ? rect[1] + dy : handle.includes("s") ? rect[3] + dy : (rect[1] + rect[3]) / 2,
    ];
    onCommit(
      resizeRect(
        rect,
        point,
        handle,
        lockedAspect,
        1 / pageWidthPoints,
        1 / pageHeightPoints,
      ),
    );
  };

  return (
    <div
      ref={overlayRef}
      className="crop-overlay"
      aria-label="Crop editor"
      onPointerDown={(event) => begin(event, "new")}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      <div
        className={`crop-selection ${drag ? "is-dragging" : ""}`}
        style={style}
        role="group"
        tabIndex={disabled ? -1 : 0}
        aria-label="Selected crop area. Use arrow keys to move it."
        onPointerDown={(event) => begin(event, hasCrop ? "move" : "new")}
        onKeyDown={moveWithKeyboard}
      >
        <span className="thirds vertical first" aria-hidden="true" />
        <span className="thirds vertical second" aria-hidden="true" />
        <span className="thirds horizontal first" aria-hidden="true" />
        <span className="thirds horizontal second" aria-hidden="true" />
        {HANDLES.map((handle) => (
          <button
            key={handle}
            type="button"
            className={`crop-handle crop-handle-${handle}`}
            aria-label={HANDLE_LABELS[handle]}
            disabled={disabled}
            onPointerDown={(event) => begin(event, "resize", handle)}
            onKeyDown={(event) => resizeWithKeyboard(event, handle)}
          />
        ))}
      </div>
    </div>
  );
}
