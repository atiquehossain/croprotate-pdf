export type Rotation = 0 | 90 | 180 | 270;

/** Normalized PDF coordinates: left, bottom, right, top. */
export type SourceCrop = [number, number, number, number] | null;

/** Normalized screen coordinates: left, top, right, bottom. */
export type VisualRect = [number, number, number, number];

export type PdfRect = [number, number, number, number];

export interface PageEdit {
  rotation: Rotation;
  crop: SourceCrop;
}

export interface PageInfo {
  index: number;
  label: string;
  originalRotation: Rotation;
  rawCropBox: PdfRect;
  rawMediaBox: PdfRect;
  userUnit: number;
  sourceWidthPoints: number;
  sourceHeightPoints: number;
}

export interface RenderedPage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export type CropUnit = "%" | "pt" | "mm" | "in";

export type AspectPreset =
  | "Free"
  | "Original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16"
  | "A4 portrait"
  | "A4 landscape";

export type TrimSensitivity = "Faint text" | "Balanced" | "Clean scan";

export type CropCopyMode = "Same relative region" | "Same physical margins";
