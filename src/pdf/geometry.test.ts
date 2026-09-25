import { describe, expect, it } from "vitest";
import type { Rotation, SourceCrop, VisualRect } from "../types";
import {
  parsePageSelection,
  sourceCropToVisualRect,
  visualRectToSourceCrop,
} from "./geometry";

describe("crop geometry", () => {
  const visual: VisualRect = [0.12, 0.2, 0.77, 0.86];
  const rotations: Rotation[] = [0, 90, 180, 270];

  it.each(rotations)("round-trips at %s degrees", (rotation) => {
    const crop = visualRectToSourceCrop(visual, rotation);
    const result = sourceCropToVisualRect(crop, rotation);
    result.forEach((value, index) => expect(value).toBeCloseTo(visual[index], 8));
  });

  it("treats a full-page crop as no crop", () => {
    expect(visualRectToSourceCrop([0, 0, 1, 1], 0)).toBeNull();
  });

  it("maps a crop across orientations", () => {
    const crop: SourceCrop = [0.1, 0.2, 0.7, 0.9];
    expect(sourceCropToVisualRect(crop, 90)).toEqual([0.2, 0.1, 0.9, 0.7]);
  });
});

describe("page selection", () => {
  it("parses ranges and removes duplicates", () => {
    expect(parsePageSelection("1, 3-5, 3", 6)).toEqual([0, 2, 3, 4]);
  });

  it("supports odd and even shortcuts", () => {
    expect(parsePageSelection("odd", 5)).toEqual([0, 2, 4]);
    expect(parsePageSelection("even", 5)).toEqual([1, 3]);
  });

  it("rejects pages outside the document", () => {
    expect(() => parsePageSelection("7", 6)).toThrow(/outside/);
  });
});
