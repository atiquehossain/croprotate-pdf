import { useEffect, useId, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Eraser,
  PenLine,
  RotateCcw,
  Signature,
  Type,
  X,
} from "lucide-react";
import { useModalDialog } from "./useModalDialog";

export type SignatureKind = "signature" | "initial";
export type SignatureInputMode = "draw" | "type";
export type SignatureFontFamily = "cursive" | "serif" | "sans-serif";

/** Normalized top-left UI coordinates local to the signature pad. */
export interface SignaturePadPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface DrawnSignatureDraft {
  input: "draw";
  kind: SignatureKind;
  strokes: SignaturePadPoint[][];
}

export interface TypedSignatureDraft {
  input: "type";
  kind: SignatureKind;
  text: string;
  fontFamily: SignatureFontFamily;
}

export type SignatureDraft = DrawnSignatureDraft | TypedSignatureDraft;

export interface SignatureDialogProps {
  open: boolean;
  kind: SignatureKind;
  busy?: boolean;
  initialValue?: SignatureDraft | null;
  onCancel: () => void;
  onConfirm: (draft: SignatureDraft) => void;
}

const FONT_OPTIONS: Array<{ value: SignatureFontFamily; label: string }> = [
  { value: "cursive", label: "Handwritten" },
  { value: "serif", label: "Classic" },
  { value: "sans-serif", label: "Clean" },
];

function pointFromEvent(
  event: PointerEvent,
  element: SVGSVGElement,
): SignaturePadPoint {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(bounds.width, 1))),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / Math.max(bounds.height, 1))),
    pressure: event.pressure > 0 ? event.pressure : 0.5,
  };
}

function strokePoints(stroke: SignaturePadPoint[]): string {
  return stroke.map((point) => `${point.x},${point.y}`).join(" ");
}

export function SignatureDialog({
  open,
  kind,
  busy = false,
  initialValue = null,
  onCancel,
  onConfirm,
}: SignatureDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const typeInputRef = useRef<HTMLInputElement>(null);
  const drawTabRef = useRef<HTMLButtonElement>(null);
  const padRef = useRef<SVGSVGElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);
  const [mode, setMode] = useState<SignatureInputMode>("draw");
  const [strokes, setStrokes] = useState<SignaturePadPoint[][]>([]);
  const [typedText, setTypedText] = useState("");
  const [fontFamily, setFontFamily] = useState<SignatureFontFamily>("cursive");
  const dialogRef = useModalDialog(open, onCancel, drawTabRef);
  const noun = kind === "initial" ? "initials" : "signature";

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    if (initialValue?.kind === kind) {
      setMode(initialValue.input);
      setStrokes(initialValue.input === "draw" ? initialValue.strokes.map((stroke) => [...stroke]) : []);
      setTypedText(initialValue.input === "type" ? initialValue.text : "");
      setFontFamily(initialValue.input === "type" ? initialValue.fontFamily : "cursive");
    } else {
      setMode("draw");
      setStrokes([]);
      setTypedText("");
      setFontFamily("cursive");
    }
  }, [initialValue, kind, open]);

  useEffect(() => {
    if (!open || mode !== "type") return;
    const frame = window.requestAnimationFrame(() => typeInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mode, open]);

  if (!open) return null;

  const beginStroke = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerIdRef.current = event.pointerId;
    const point = pointFromEvent(event.nativeEvent, event.currentTarget);
    setStrokes((current) => [...current, [point]]);
  };

  const extendStroke = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (busy || pointerIdRef.current !== event.pointerId || !padRef.current) return;
    event.preventDefault();
    const events = typeof event.nativeEvent.getCoalescedEvents === "function"
      ? event.nativeEvent.getCoalescedEvents()
      : [event.nativeEvent];
    const nextPoints = events.map((item) => pointFromEvent(item, padRef.current!));
    setStrokes((current) => {
      if (current.length === 0) return current;
      const next = current.map((stroke, index) => index === current.length - 1 ? [...stroke] : stroke);
      const active = next[next.length - 1];
      for (const point of nextPoints) {
        const previous = active[active.length - 1];
        if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.0015) {
          active.push(point);
        }
      }
      return next;
    });
  };

  const endStroke = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
  };

  const confirm = () => {
    if (mode === "draw") {
      const nonEmpty = strokes.filter((stroke) => stroke.length > 0);
      if (nonEmpty.length === 0) return;
      onConfirm({ input: "draw", kind, strokes: nonEmpty.map((stroke) => [...stroke]) });
      return;
    }
    const text = typedText.trim();
    if (!text) return;
    onConfirm({ input: "type", kind, text, fontFamily });
  };

  const canConfirm = mode === "draw"
    ? strokes.some((stroke) => stroke.length > 0)
    : typedText.trim().length > 0;

  return (
    <div
      className="modal-backdrop annotation-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal annotation-dialog signature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <button type="button" className="modal-close" aria-label={`Close ${noun} dialog`} disabled={busy} onClick={onCancel}>
          <X size={18} />
        </button>
        <div className="modal-icon"><Signature size={21} /></div>
        <h2 id={titleId}>Add {noun}</h2>
        <p id={descriptionId}>Draw with a mouse, finger, or stylus—or type it. It stays in this tab until you save the PDF.</p>

        <div className="annotation-dialog-tabs" role="tablist" aria-label={`${noun} input method`}>
          <button
            ref={drawTabRef}
            id="signature-tab-draw"
            type="button"
            role="tab"
            aria-selected={mode === "draw"}
            aria-controls="signature-panel-draw"
            className={mode === "draw" ? "is-active" : ""}
            tabIndex={mode === "draw" ? 0 : -1}
            onClick={() => setMode("draw")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              setMode("type");
            }}
          >
            <PenLine size={17} /> Draw
          </button>
          <button
            id="signature-tab-type"
            type="button"
            role="tab"
            aria-selected={mode === "type"}
            aria-controls="signature-panel-type"
            className={mode === "type" ? "is-active" : ""}
            tabIndex={mode === "type" ? 0 : -1}
            onClick={() => setMode("type")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              setMode("draw");
              window.requestAnimationFrame(() => drawTabRef.current?.focus());
            }}
          >
            <Type size={17} /> Type
          </button>
        </div>

        {mode === "draw" ? (
          <div id="signature-panel-draw" role="tabpanel" aria-labelledby="signature-tab-draw" className="signature-draw-panel">
            <svg
              ref={padRef}
              className="signature-pad"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Drawing pad for ${noun}. A typed option is also available.`}
              onPointerDown={beginStroke}
              onPointerMove={extendStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
            >
              <title>Drawn {noun} preview</title>
              <line className="signature-baseline" x1="0.06" y1="0.76" x2="0.94" y2="0.76" vectorEffect="non-scaling-stroke" />
              {strokes.map((stroke, index) => (
                stroke.length === 1 ? (
                  <circle
                    key={index}
                    className="signature-stroke"
                    cx={stroke[0].x}
                    cy={stroke[0].y}
                    r="0.004"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : (
                  <polyline
                    key={index}
                    className="signature-stroke"
                    points={strokePoints(stroke)}
                    vectorEffect="non-scaling-stroke"
                  />
                )
              ))}
            </svg>
            <div className="signature-pad-actions">
              <span>Sign above the line</span>
              <button type="button" disabled={busy || strokes.length === 0} onClick={() => setStrokes((current) => current.slice(0, -1))}>
                <RotateCcw size={15} /> Undo stroke
              </button>
              <button type="button" disabled={busy || strokes.length === 0} onClick={() => setStrokes([])}>
                <Eraser size={15} /> Clear
              </button>
            </div>
          </div>
        ) : (
          <div id="signature-panel-type" role="tabpanel" aria-labelledby="signature-tab-type" className="signature-type-panel">
            <label className="field-label" htmlFor="signature-name">
              {kind === "initial" ? "Your initials" : "Your name"}
              <input
                ref={typeInputRef}
                id="signature-name"
                value={typedText}
                maxLength={kind === "initial" ? 12 : 80}
                autoComplete="off"
                placeholder={kind === "initial" ? "A.H." : "Type your name"}
                disabled={busy}
                onChange={(event) => setTypedText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canConfirm && !busy) confirm();
                }}
              />
            </label>
            <label className="field-label" htmlFor="signature-font">
              Style
              <select id="signature-font" value={fontFamily} disabled={busy} onChange={(event) => setFontFamily(event.target.value as SignatureFontFamily)}>
                {FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <div className={`typed-signature-preview font-${fontFamily}`} aria-label="Typed signature preview">
              {typedText.trim() || (kind === "initial" ? "A.H." : "Your name")}
            </div>
          </div>
        )}

        <div className="signature-legal-note">
          <strong>Visual electronic {noun}:</strong> not certificate-backed, identity-verified, or equivalent to a cryptographic digital signature.
        </div>

        <div className="annotation-dialog-actions">
          <button type="button" className="full-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-button" disabled={busy || !canConfirm} onClick={confirm}>Continue to place</button>
        </div>
      </div>
    </div>
  );
}
