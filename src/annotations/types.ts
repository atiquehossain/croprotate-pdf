/** Stable identity for a physical page occurrence in the organizer. */
export type AnnotationPageId = string;

export type AnnotationId = string;

/**
 * A normalized point in the original PDF page's source coordinate system.
 * X grows left-to-right and Y grows bottom-to-top. Both axes normally use 0..1.
 */
export interface AnnotationPoint {
  x: number;
  y: number;
  /** Optional stylus pressure, normalized to 0..1. */
  pressure?: number;
}

/** A normalized, axis-aligned rectangle in PDF source coordinates. */
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationTextAlign = "left" | "center" | "right";

export interface AnnotationStyle {
  /** CSS color used when displaying and exporting this item. */
  color: string;
  /** Opacity normalized to 0..1. */
  opacity: number;
  /** Stroke width in physical PDF points (1/72 inch), independent of zoom. */
  width: number;
}

export interface AnnotationBase extends AnnotationStyle {
  id: AnnotationId;
  pageId: AnnotationPageId;
  /** Optional human-readable name for accessibility and the object list. */
  label?: string;
}

export interface InkAnnotation extends AnnotationBase {
  kind: "ink";
  tool: "pen" | "signature" | "initial";
  /** One selectable ink object may contain several disconnected strokes. */
  strokes: AnnotationPoint[][];
}

export interface HighlightAnnotation extends AnnotationBase {
  kind: "highlight";
  tool: "highlighter";
  points: AnnotationPoint[];
}

export interface TextAnnotation extends AnnotationBase {
  kind: "text";
  tool: "text" | "date" | "signature" | "initial";
  rect: AnnotationRect;
  text: string;
  /** Font size in physical PDF points (1/72 inch), independent of zoom. */
  fontSize: number;
  fontFamily?: "sans-serif" | "serif" | "monospace" | "cursive";
  align?: AnnotationTextAlign;
}

export interface MarkAnnotation extends AnnotationBase {
  kind: "mark";
  tool: "check" | "cross";
  rect: AnnotationRect;
}

export interface LineAnnotation extends AnnotationBase {
  kind: "line";
  tool: "line" | "arrow";
  start: AnnotationPoint;
  end: AnnotationPoint;
}

export interface ShapeAnnotation extends AnnotationBase {
  kind: "shape";
  tool: "rectangle" | "ellipse";
  rect: AnnotationRect;
  fillColor?: string;
  /** Fill opacity normalized to 0..1. Omission means no fill. */
  fillOpacity?: number;
}

export type Annotation =
  | InkAnnotation
  | HighlightAnnotation
  | TextAnnotation
  | MarkAnnotation
  | LineAnnotation
  | ShapeAnnotation;

/**
 * Annotation arrays are paint-ordered: later items render above earlier items.
 * Page IDs, rather than page indices, keep items attached through reordering.
 */
export interface AnnotationDocument {
  version: 1;
  pages: Record<AnnotationPageId, Annotation[]>;
}

export type PersistedAnnotationTool = Annotation["tool"];

/** Includes editing modes which are never persisted as annotations. */
export type AnnotationTool = PersistedAnnotationTool | "select" | "eraser";
