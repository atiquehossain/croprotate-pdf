import { useId, useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  BadgeCheck,
  CalendarDays,
  Check,
  Circle,
  Copy,
  Eraser,
  Highlighter,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  RectangleHorizontal,
  Redo2,
  Signature,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import type {
  AnnotationStyle,
  AnnotationTool,
} from "../../annotations/types";

interface ToolDefinition {
  tool: AnnotationTool;
  label: string;
  hint: string;
  icon: typeof MousePointer2;
  section: "draw" | "content" | "shape";
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    tool: "select",
    label: "Select",
    hint: "Select, move, resize, or use the keyboard to edit an item.",
    icon: MousePointer2,
    section: "draw",
  },
  {
    tool: "pen",
    label: "Pen",
    hint: "Draw a smooth freehand line with a mouse, finger, or stylus.",
    icon: Pencil,
    section: "draw",
  },
  {
    tool: "highlighter",
    label: "Highlight",
    hint: "Drag over text or an area to add a translucent highlight.",
    icon: Highlighter,
    section: "draw",
  },
  {
    tool: "eraser",
    label: "Eraser",
    hint: "Tap an annotation to remove it. The underlying PDF is unchanged.",
    icon: Eraser,
    section: "draw",
  },
  {
    tool: "text",
    label: "Text",
    hint: "Click the page, enter text, and choose its appearance.",
    icon: Type,
    section: "content",
  },
  {
    tool: "date",
    label: "Date",
    hint: "Click the page to place today’s date or choose another date.",
    icon: CalendarDays,
    section: "content",
  },
  {
    tool: "check",
    label: "Check",
    hint: "Click or drag to add a check mark.",
    icon: Check,
    section: "content",
  },
  {
    tool: "cross",
    label: "Cross",
    hint: "Click or drag to add a cross mark.",
    icon: X,
    section: "content",
  },
  {
    tool: "signature",
    label: "Signature",
    hint: "Draw or type a visual electronic signature, then place it.",
    icon: Signature,
    section: "content",
  },
  {
    tool: "initial",
    label: "Initials",
    hint: "Draw or type initials, then place them on the page.",
    icon: BadgeCheck,
    section: "content",
  },
  {
    tool: "line",
    label: "Line",
    hint: "Drag from the line’s start point to its end point.",
    icon: Minus,
    section: "shape",
  },
  {
    tool: "arrow",
    label: "Arrow",
    hint: "Drag from the arrow’s start point toward its tip.",
    icon: MoveUpRight,
    section: "shape",
  },
  {
    tool: "rectangle",
    label: "Rectangle",
    hint: "Drag to outline a rectangular area.",
    icon: RectangleHorizontal,
    section: "shape",
  },
  {
    tool: "ellipse",
    label: "Ellipse",
    hint: "Drag to outline an oval or circle.",
    icon: Circle,
    section: "shape",
  },
];

const COLOR_SWATCHES = [
  "#111827",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#0ea5e9",
  "#6366f1",
] as const;

const SECTION_LABELS = {
  draw: "Choose or draw",
  content: "Add content",
  shape: "Lines and shapes",
} as const;

export interface AnnotationToolbarProps {
  pageNumber: number;
  activeTool: AnnotationTool;
  style: AnnotationStyle;
  busy?: boolean;
  hasSelection?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  /** Called before signature/initial placement so a private reusable template can be prepared. */
  onPrepareSignature?: (kind: "signature" | "initial") => void;
  onStyleChange: (style: AnnotationStyle) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

export function AnnotationToolbar({
  pageNumber,
  activeTool,
  style,
  busy = false,
  hasSelection = false,
  canUndo = false,
  canRedo = false,
  onToolChange,
  onPrepareSignature,
  onStyleChange,
  onUndo,
  onRedo,
  onDuplicate,
  onDelete,
}: AnnotationToolbarProps) {
  const hintId = useId();
  const toolsRef = useRef<HTMLDivElement>(null);
  const activeDefinition = TOOL_DEFINITIONS.find(({ tool }) => tool === activeTool)
    ?? TOOL_DEFINITIONS[0];
  const widthPoints = style.width;

  const changeStyle = (partial: Partial<AnnotationStyle>) => {
    onStyleChange({ ...style, ...partial });
  };

  const moveToolFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const buttons = Array.from(
      toolsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-annotation-tool]") ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(event.currentTarget));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <aside className="inspector annotation-inspector" aria-label="Annotate and sign controls">
      <div className="inspector-heading annotation-heading">
        <div>
          <span className="eyebrow">Page {pageNumber}</span>
          <h2>Annotate &amp; sign</h2>
        </div>
        <div className="history-controls" aria-label="Annotation history">
          <button
            type="button"
            className="icon-button"
            aria-label="Undo annotation change"
            title="Undo annotation change"
            disabled={busy || !canUndo}
            onClick={onUndo}
          >
            <Undo2 size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Redo annotation change"
            title="Redo annotation change"
            disabled={busy || !canRedo}
            onClick={onRedo}
          >
            <Redo2 size={17} />
          </button>
        </div>
      </div>

      <div className="annotation-panel">
        <section className="control-section annotation-tool-section">
          <div className="section-title">
            <span>Tools</span>
            <output aria-live="polite">{activeDefinition.label}</output>
          </div>
          <div ref={toolsRef} className="annotation-tool-groups">
            {(Object.keys(SECTION_LABELS) as ToolDefinition["section"][]).map((section) => (
              <div key={section} className="annotation-tool-group" role="toolbar" aria-label={SECTION_LABELS[section]}>
                {TOOL_DEFINITIONS.filter((definition) => definition.section === section).map((definition) => {
                  const Icon = definition.icon;
                  const active = definition.tool === activeTool;
                  return (
                    <button
                      key={definition.tool}
                      type="button"
                      className={`annotation-tool${active ? " is-active" : ""}`}
                      data-annotation-tool={definition.tool}
                      aria-label={definition.label}
                      aria-pressed={active}
                      aria-describedby={active ? hintId : undefined}
                      title={definition.label}
                      disabled={busy}
                      tabIndex={active ? 0 : -1}
                      onClick={() => {
                        if ((definition.tool === "signature" || definition.tool === "initial") && onPrepareSignature) {
                          onPrepareSignature(definition.tool);
                        } else {
                          onToolChange(definition.tool);
                        }
                      }}
                      onKeyDown={moveToolFocus}
                    >
                      <Icon size={19} strokeWidth={1.9} aria-hidden="true" />
                      <span>{definition.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <p id={hintId} className="annotation-tool-hint" aria-live="polite">
            {activeDefinition.hint}
          </p>
        </section>

        <section className="control-section annotation-style-section">
          <div className="section-title"><span>Appearance</span></div>
          <fieldset className="annotation-colors" disabled={busy}>
            <legend>Color</legend>
            <div className="annotation-swatch-row">
              {COLOR_SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`annotation-swatch${style.color.toLowerCase() === color ? " is-active" : ""}`}
                  style={{ "--swatch": color } as CSSProperties}
                  aria-label={`Use ${color} color`}
                  aria-pressed={style.color.toLowerCase() === color}
                  onClick={() => changeStyle({ color })}
                />
              ))}
              <label className="annotation-custom-color" title="Choose a custom color">
                <span className="visually-hidden">Custom annotation color</span>
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : "#111827"}
                  aria-label="Choose a custom annotation color"
                  onChange={(event) => changeStyle({ color: event.target.value })}
                />
              </label>
            </div>
          </fieldset>

          <label className="annotation-range-row">
            <span>
              Width
              <output>{widthPoints.toFixed(widthPoints < 10 ? 1 : 0)} pt</output>
            </span>
            <input
              type="range"
              min="0.5"
              max="40"
              step="0.5"
              value={Math.min(40, Math.max(0.5, widthPoints))}
              disabled={busy}
              aria-label="Annotation stroke width"
              onChange={(event) => changeStyle({ width: Number(event.target.value) })}
            />
          </label>

          <label className="annotation-range-row">
            <span>
              Opacity
              <output>{Math.round(style.opacity * 100)}%</output>
            </span>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={style.opacity}
              disabled={busy}
              aria-label="Annotation opacity"
              onChange={(event) => changeStyle({ opacity: Number(event.target.value) })}
            />
          </label>
        </section>

        <section className="control-section annotation-object-section" aria-labelledby="annotation-object-title">
          <div id="annotation-object-title" className="section-title">
            <span>Selected item</span>
            <output>{hasSelection ? "1 selected" : "None"}</output>
          </div>
          <div className="annotation-object-actions">
            <button type="button" disabled={busy || !hasSelection} onClick={onDuplicate}>
              <Copy size={16} aria-hidden="true" /> Duplicate
            </button>
            <button className="is-danger" type="button" disabled={busy || !hasSelection} onClick={onDelete}>
              <Trash2 size={16} aria-hidden="true" /> Delete
            </button>
          </div>
          <p className="help-text">Select an item to move, resize, duplicate, or delete it. Arrow keys move it; hold Shift for larger steps.</p>
        </section>

        <aside className="signature-disclaimer" aria-label="Electronic signature notice">
          <Signature size={17} aria-hidden="true" />
          <p>
            <strong>Visual signature only.</strong> It is not a certificate-backed digital signature and does not verify identity.
          </p>
        </aside>
      </div>
    </aside>
  );
}

export { TOOL_DEFINITIONS as ANNOTATION_TOOL_DEFINITIONS };
