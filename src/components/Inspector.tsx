import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  Crop,
  Redo2,
  RotateCcw,
  RotateCw,
  Undo2,
} from "lucide-react";
import type {
  AspectPreset,
  CropCopyMode,
  CropUnit,
  PageEdit,
  PageInfo,
  Rotation,
  TrimSensitivity,
  VisualRect,
} from "../types";
import {
  pointMarginsToVisualRect,
  pointsToUnit,
  totalRotation,
  unitToPoints,
  visualPageDimensions,
  visualRectToPointMargins,
} from "../pdf/geometry";
import type { Margins } from "../pdf/geometry";

type InspectorTab = "edit" | "precision" | "batch";
const INSPECTOR_TABS: InspectorTab[] = ["edit", "precision", "batch"];

interface InspectorProps {
  pageInfo: PageInfo;
  pageEdit: PageEdit;
  visualCrop: VisualRect;
  aspectPreset: AspectPreset;
  aspectLocked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  onAspectPresetChange: (preset: AspectPreset) => void;
  onAspectLockedChange: (locked: boolean) => void;
  onRotate: (rotation: Rotation) => void;
  onResetRotation: () => void;
  onCropCommit: (rect: VisualRect) => void;
  onResetCrop: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFitAspect: () => void;
  onAutoTrim: (
    sensitivity: TrimSensitivity,
    padding: number,
    includeAnnotations: boolean,
  ) => Promise<void>;
  onBatchApply: (options: {
    pageSpecification: string;
    mode: CropCopyMode;
    applyCrop: boolean;
    applyRotation: boolean;
  }) => void;
  onStatus: (message: string) => void;
}

const ASPECTS: AspectPreset[] = [
  "Free",
  "Original",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "A4 portrait",
  "A4 landscape",
];

const UNITS: CropUnit[] = ["%", "pt", "mm", "in"];

function formatNumber(value: number, unit: CropUnit): string {
  const digits = unit === "pt" ? 1 : 2;
  return Number(value.toFixed(digits)).toString();
}

export function Inspector({
  pageInfo,
  pageEdit,
  visualCrop,
  aspectPreset,
  aspectLocked,
  canUndo,
  canRedo,
  busy,
  onAspectPresetChange,
  onAspectLockedChange,
  onRotate,
  onResetRotation,
  onCropCommit,
  onResetCrop,
  onUndo,
  onRedo,
  onFitAspect,
  onAutoTrim,
  onBatchApply,
  onStatus,
}: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("edit");
  const [unit, setUnit] = useState<CropUnit>("%");
  const [marginFields, setMarginFields] = useState<Record<keyof Margins, string>>({
    left: "0",
    top: "0",
    right: "0",
    bottom: "0",
  });
  const [sensitivity, setSensitivity] = useState<TrimSensitivity>("Balanced");
  const [padding, setPadding] = useState("6");
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [pageSpecification, setPageSpecification] = useState("all");
  const [copyMode, setCopyMode] = useState<CropCopyMode>("Same relative region");
  const [applyCrop, setApplyCrop] = useState(true);
  const [applyRotation, setApplyRotation] = useState(false);

  const rotation = totalRotation(pageInfo, pageEdit.rotation);
  const [pageWidth, pageHeight] = useMemo(
    () => visualPageDimensions(pageInfo, rotation),
    [pageInfo, rotation],
  );
  const pointMargins = useMemo(
    () => visualRectToPointMargins(visualCrop, pageWidth, pageHeight),
    [pageHeight, pageWidth, visualCrop],
  );
  const cropWidth = (visualCrop[2] - visualCrop[0]) * pageWidth;
  const cropHeight = (visualCrop[3] - visualCrop[1]) * pageHeight;
  const retained = (visualCrop[2] - visualCrop[0]) * (visualCrop[3] - visualCrop[1]) * 100;

  useEffect(() => {
    const next = { ...pointMargins };
    if (unit === "%") {
      setMarginFields({
        left: formatNumber(visualCrop[0] * 100, unit),
        top: formatNumber(visualCrop[1] * 100, unit),
        right: formatNumber((1 - visualCrop[2]) * 100, unit),
        bottom: formatNumber((1 - visualCrop[3]) * 100, unit),
      });
      return;
    }
    setMarginFields({
      left: formatNumber(pointsToUnit(next.left, unit), unit),
      top: formatNumber(pointsToUnit(next.top, unit), unit),
      right: formatNumber(pointsToUnit(next.right, unit), unit),
      bottom: formatNumber(pointsToUnit(next.bottom, unit), unit),
    });
  }, [pointMargins, unit, visualCrop]);

  const applyMargins = () => {
    const parsed = Object.fromEntries(
      Object.entries(marginFields).map(([key, value]) => [key, Number(value)]),
    ) as unknown as Margins;
    if (Object.values(parsed).some((value) => !Number.isFinite(value) || value < 0)) {
      onStatus("Margins must be non-negative numbers.");
      return;
    }
    let rect: VisualRect;
    if (unit === "%") {
      rect = [
        parsed.left / 100,
        parsed.top / 100,
        1 - parsed.right / 100,
        1 - parsed.bottom / 100,
      ];
    } else {
      const points: Margins = {
        left: unitToPoints(parsed.left, unit),
        top: unitToPoints(parsed.top, unit),
        right: unitToPoints(parsed.right, unit),
        bottom: unitToPoints(parsed.bottom, unit),
      };
      rect = pointMarginsToVisualRect(points, pageWidth, pageHeight);
    }
    if (rect[0] >= rect[2] || rect[1] >= rect[3]) {
      onStatus("Opposing margins leave no crop area.");
      return;
    }
    onCropCommit(rect);
  };

  const runAutoTrim = async () => {
    const parsedPadding = Number(padding);
    if (!Number.isFinite(parsedPadding) || parsedPadding < 0 || parsedPadding > 144) {
      onStatus("Auto-trim padding must be between 0 and 144 points.");
      return;
    }
    await onAutoTrim(sensitivity, parsedPadding, includeAnnotations);
  };

  return (
    <aside className="inspector" aria-label="Editing controls">
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">Page {pageInfo.index + 1}</span>
          <h2>Crop &amp; rotate</h2>
        </div>
        <div className="history-controls">
          <button type="button" className="icon-button" aria-label="Undo" disabled={!canUndo || busy} onClick={onUndo}>
            <Undo2 size={17} />
          </button>
          <button type="button" className="icon-button" aria-label="Redo" disabled={!canRedo || busy} onClick={onRedo}>
            <Redo2 size={17} />
          </button>
        </div>
      </div>

      <div className="inspector-tabs" role="tablist" aria-label="Editor panels">
        {INSPECTOR_TABS.map((value) => (
          <button
            key={value}
            id={`editor-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`editor-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "is-active" : ""}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const current = INSPECTOR_TABS.indexOf(value);
              const target = event.key === "Home"
                ? 0
                : event.key === "End"
                  ? INSPECTOR_TABS.length - 1
                  : (current + (event.key === "ArrowRight" ? 1 : -1) + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
              const nextTab = INSPECTOR_TABS[target];
              setTab(nextTab);
              window.requestAnimationFrame(() => document.getElementById(`editor-tab-${nextTab}`)?.focus());
            }}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>

      {tab === "edit" && (
        <div id="editor-panel-edit" className="inspector-panel" role="tabpanel" aria-labelledby="editor-tab-edit">
          <section className="control-section">
            <div className="section-title">
              <span>Rotation</span>
              <output>{pageEdit.rotation === 0 ? "Original" : `+${pageEdit.rotation}°`}</output>
            </div>
            <div className="button-grid three">
              <button type="button" disabled={busy} onClick={() => onRotate(270)}>
                <RotateCcw size={17} /> Left
              </button>
              <button type="button" disabled={busy} onClick={onResetRotation}>Reset</button>
              <button type="button" disabled={busy} onClick={() => onRotate(90)}>
                <RotateCw size={17} /> Right
              </button>
            </div>
          </section>

          <section className="control-section">
            <div className="section-title">
              <span>Crop selection</span>
              <Crop size={17} />
            </div>
            <div className="crop-readout">
              <strong>{cropWidth.toFixed(1)} × {cropHeight.toFixed(1)} pt</strong>
              <span>{retained.toFixed(1)}% of page retained</span>
            </div>
            <p className="help-text">Draw anywhere on the preview. Drag inside to move, or use any handle to resize.</p>
            <button className="full-button" type="button" disabled={busy || pageEdit.crop === null} onClick={onResetCrop}>
              Reset crop to full page
            </button>
          </section>

          <section className="control-section">
            <div className="section-title"><span>Aspect ratio</span></div>
            <label className="field-label" htmlFor="aspect-preset">Preset</label>
            <select
              id="aspect-preset"
              value={aspectPreset}
              disabled={busy}
              onChange={(event) => onAspectPresetChange(event.target.value as AspectPreset)}
            >
              {ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}
            </select>
            <label className="check-row">
              <input
                type="checkbox"
                checked={aspectLocked}
                disabled={busy || aspectPreset === "Free"}
                onChange={(event) => onAspectLockedChange(event.target.checked)}
              />
              Lock ratio while resizing
            </label>
            <button className="full-button" type="button" disabled={busy || aspectPreset === "Free"} onClick={onFitAspect}>
              Fit selection to ratio
            </button>
          </section>
        </div>
      )}

      {tab === "precision" && (
        <div id="editor-panel-precision" className="inspector-panel" role="tabpanel" aria-labelledby="editor-tab-precision">
          <section className="control-section">
            <div className="section-title"><span>Exact margins</span></div>
            <div className="field-row unit-row">
              <label className="field-label" htmlFor="margin-unit">Unit</label>
              <select id="margin-unit" value={unit} onChange={(event) => setUnit(event.target.value as CropUnit)}>
                {UNITS.map((value) => <option key={value}>{value}</option>)}
              </select>
            </div>
            <div className="margin-grid">
              {(Object.keys(marginFields) as (keyof Margins)[]).map((key) => (
                <label key={key} className="field-label">
                  {key[0].toUpperCase() + key.slice(1)}
                  <input
                    inputMode="decimal"
                    value={marginFields[key]}
                    disabled={busy}
                    onChange={(event) => setMarginFields((current) => ({ ...current, [key]: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === "Enter") applyMargins(); }}
                  />
                </label>
              ))}
            </div>
            <button className="primary-button full-button" type="button" disabled={busy} onClick={applyMargins}>
              <Check size={17} /> Apply exact margins
            </button>
          </section>

          <section className="control-section">
            <div className="section-title">
              <span>Automatic trim</span>
              <Bot size={17} />
            </div>
            <label className="field-label" htmlFor="trim-sensitivity">Sensitivity</label>
            <select
              id="trim-sensitivity"
              value={sensitivity}
              disabled={busy}
              onChange={(event) => setSensitivity(event.target.value as TrimSensitivity)}
            >
              <option>Faint text</option>
              <option>Balanced</option>
              <option>Clean scan</option>
            </select>
            <label className="field-label" htmlFor="trim-padding">
              Padding (points)
              <input id="trim-padding" inputMode="decimal" value={padding} disabled={busy} onChange={(event) => setPadding(event.target.value)} />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={includeAnnotations} disabled={busy} onChange={(event) => setIncludeAnnotations(event.target.checked)} />
              Include annotations
            </label>
            <button className="primary-button full-button" type="button" disabled={busy} onClick={() => void runAutoTrim()}>
              Auto-trim this page
            </button>
            <p className="help-text">Runs locally in a background worker. Blank or uncertain pages are left unchanged.</p>
          </section>
        </div>
      )}

      {tab === "batch" && (
        <div id="editor-panel-batch" className="inspector-panel" role="tabpanel" aria-labelledby="editor-tab-batch">
          <section className="control-section">
            <div className="section-title"><span>Copy current settings</span></div>
            <label className="field-label" htmlFor="batch-pages">
              Target pages
              <input id="batch-pages" value={pageSpecification} disabled={busy} placeholder="all, odd, even, or 1,3-5" onChange={(event) => setPageSpecification(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="copy-mode">Crop mapping</label>
            <select id="copy-mode" value={copyMode} disabled={busy} onChange={(event) => setCopyMode(event.target.value as CropCopyMode)}>
              <option>Same relative region</option>
              <option>Same physical margins</option>
            </select>
            <div className="stacked-checks">
              <label className="check-row">
                <input type="checkbox" checked={applyCrop} disabled={busy} onChange={(event) => setApplyCrop(event.target.checked)} />
                Apply crop
              </label>
              <label className="check-row">
                <input type="checkbox" checked={applyRotation} disabled={busy} onChange={(event) => setApplyRotation(event.target.checked)} />
                Apply rotation
              </label>
            </div>
            <button
              className="primary-button full-button"
              type="button"
              disabled={busy || (!applyCrop && !applyRotation)}
              onClick={() => onBatchApply({ pageSpecification, mode: copyMode, applyCrop, applyRotation })}
            >
              Apply to selected pages
            </button>
            <p className="help-text">Examples: <code>all</code>, <code>odd</code>, <code>2-5,8</code>. Batch edits undo in one step.</p>
          </section>
        </div>
      )}
    </aside>
  );
}
