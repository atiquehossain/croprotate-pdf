import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, Type, X } from "lucide-react";
import type { AnnotationTextAlign, TextAnnotation } from "../../annotations/types";
import { useModalDialog } from "./useModalDialog";

export type TextComposerTool = "text" | "date";
export type TextFontFamily = NonNullable<TextAnnotation["fontFamily"]>;

export interface TextComposerValue {
  text: string;
  /** Font size in physical PDF points, matching TextAnnotation. */
  fontSize: number;
  fontFamily: TextFontFamily;
  align: AnnotationTextAlign;
}

export interface TextAnnotationDialogProps {
  open: boolean;
  tool: TextComposerTool;
  busy?: boolean;
  initialValue?: TextComposerValue | null;
  onCancel: () => void;
  onConfirm: (value: TextComposerValue) => void;
}

type DateFormat = "medium" | "long" | "numeric" | "iso";

function todayValue(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value: string, format: DateFormat): string {
  if (format === "iso") return value;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(year, month - 1, day);
  const options: Intl.DateTimeFormatOptions = format === "long"
    ? { year: "numeric", month: "long", day: "numeric" }
    : format === "numeric"
      ? { year: "numeric", month: "2-digit", day: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

export function TextAnnotationDialog({
  open,
  tool,
  busy = false,
  initialValue = null,
  onCancel,
  onConfirm,
}: TextAnnotationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const [text, setText] = useState("");
  const [date, setDate] = useState(todayValue);
  const [dateFormat, setDateFormat] = useState<DateFormat>("medium");
  const [fontSizePoints, setFontSizePoints] = useState(14);
  const [fontFamily, setFontFamily] = useState<TextFontFamily>("sans-serif");
  const [align, setAlign] = useState<AnnotationTextAlign>("left");
  const initialFocusRef = tool === "text" ? textRef : dateInputRef;
  const dialogRef = useModalDialog(open, onCancel, initialFocusRef);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setText(initialValue?.text ?? "");
    setDate(todayValue());
    setDateFormat("medium");
    setFontSizePoints(Math.min(72, Math.max(6, initialValue?.fontSize ?? 14)));
    setFontFamily(initialValue?.fontFamily ?? "sans-serif");
    setAlign(initialValue?.align ?? "left");
  }, [initialValue, open]);

  if (!open) return null;

  const outputText = tool === "date" ? formatDate(date, dateFormat) : text.trim();
  const confirm = () => {
    if (!outputText) return;
    onConfirm({
      text: outputText,
      fontSize: fontSizePoints,
      fontFamily,
      align,
    });
  };

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
        className="modal annotation-dialog text-annotation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <button type="button" className="modal-close" aria-label="Close text dialog" disabled={busy} onClick={onCancel}>
          <X size={18} />
        </button>
        <div className="modal-icon">{tool === "date" ? <CalendarDays size={21} /> : <Type size={21} />}</div>
        <h2 id={titleId}>{tool === "date" ? "Add a date" : "Add text"}</h2>
        <p id={descriptionId}>Choose the content and appearance. It will be added where you clicked.</p>

        {tool === "date" ? (
          <div className="annotation-date-fields">
            <label className="field-label" htmlFor="annotation-date-value">
              Date
              <input ref={dateInputRef} id="annotation-date-value" type="date" value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="annotation-date-format">
              Format
              <select id="annotation-date-format" value={dateFormat} disabled={busy} onChange={(event) => setDateFormat(event.target.value as DateFormat)}>
                <option value="medium">{formatDate(date, "medium")}</option>
                <option value="long">{formatDate(date, "long")}</option>
                <option value="numeric">{formatDate(date, "numeric")}</option>
                <option value="iso">{formatDate(date, "iso")}</option>
              </select>
            </label>
          </div>
        ) : (
          <label className="field-label" htmlFor="annotation-text-value">
            Text
            <textarea
              ref={textRef}
              id="annotation-text-value"
              rows={4}
              maxLength={1000}
              value={text}
              disabled={busy}
              placeholder="Type a note, name, address, or form response"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && text.trim() && !busy) confirm();
              }}
            />
          </label>
        )}

        <div className="annotation-text-options">
          <label className="field-label" htmlFor="annotation-font-family">
            Font
            <select id="annotation-font-family" value={fontFamily} disabled={busy} onChange={(event) => setFontFamily(event.target.value as TextFontFamily)}>
              <option value="sans-serif">Sans serif</option>
              <option value="serif">Serif</option>
              <option value="monospace">Monospace</option>
              <option value="cursive">Handwritten</option>
            </select>
          </label>
          <label className="field-label" htmlFor="annotation-font-size">
            Size (pt)
            <input
              id="annotation-font-size"
              type="number"
              min="6"
              max="72"
              step="1"
              inputMode="decimal"
              value={Number(fontSizePoints.toFixed(1))}
              disabled={busy}
              onChange={(event) => setFontSizePoints(Math.min(72, Math.max(6, Number(event.target.value) || 6)))}
            />
          </label>
          <label className="field-label" htmlFor="annotation-text-align">
            Align
            <select id="annotation-text-align" value={align} disabled={busy} onChange={(event) => setAlign(event.target.value as AnnotationTextAlign)}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
        </div>

        <div
          className={`annotation-text-preview font-${fontFamily}`}
          style={{ fontSize: `${Math.min(30, Math.max(12, fontSizePoints))}px`, textAlign: align }}
          aria-label="Text preview"
        >
          {outputText || "Preview"}
        </div>

        <div className="annotation-dialog-actions">
          <button type="button" className="full-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-button" disabled={busy || !outputText} onClick={confirm}>Add to page</button>
        </div>
      </div>
    </div>
  );
}
