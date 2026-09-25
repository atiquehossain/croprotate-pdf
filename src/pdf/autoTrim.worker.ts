interface AnalyzeRequest {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  tolerance: number;
  paddingPixels: number;
}

type AnalyzeResponse =
  | { ok: true; rect: [number, number, number, number] | null }
  | { ok: false; error: string };

function analyze({
  pixels,
  width,
  height,
  tolerance: baseTolerance,
  paddingPixels,
}: AnalyzeRequest): [number, number, number, number] | null {
  if (width < 4 || height < 4) return null;
  const rgba = new Uint8ClampedArray(pixels);
  const grayscale = new Uint8Array(width * height);

  for (let index = 0, pixel = 0; index < grayscale.length; index += 1, pixel += 4) {
    const alpha = rgba[pixel + 3] / 255;
    const luminance =
      0.2126 * rgba[pixel] + 0.7152 * rgba[pixel + 1] + 0.0722 * rgba[pixel + 2];
    grayscale[index] = Math.round(luminance * alpha + 255 * (1 - alpha));
  }

  const band = Math.min(32, Math.max(1, Math.floor(Math.min(width, height) / 100)));
  const histogram = new Uint32Array(256);
  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < band || y >= height - band;
    const row = y * width;
    if (edgeRow) {
      for (let x = 0; x < width; x += 1) histogram[grayscale[row + x]] += 1;
    } else {
      for (let x = 0; x < band; x += 1) histogram[grayscale[row + x]] += 1;
      for (let x = width - band; x < width; x += 1) {
        histogram[grayscale[row + x]] += 1;
      }
    }
  }

  let background = 0;
  let largestBucket = 0;
  let borderCount = 0;
  for (let value = 0; value < 256; value += 1) {
    const count = histogram[value];
    borderCount += count;
    if (count > largestBucket) {
      largestBucket = count;
      background = value;
    }
  }
  let peakCount = 0;
  for (let value = Math.max(0, background - 4); value <= Math.min(255, background + 4); value += 1) {
    peakCount += histogram[value];
  }
  if (!borderCount || peakCount / borderCount < 0.28) return null;

  const deviations = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    deviations[Math.abs(value - background)] += histogram[value];
  }
  let cumulative = 0;
  let mad = 0;
  for (let deviation = 0; deviation < 256; deviation += 1) {
    cumulative += deviations[deviation];
    if (cumulative >= borderCount / 2) {
      mad = deviation;
      break;
    }
  }
  const tolerance = Math.min(Math.max(baseTolerance, 3 * mad + 3, 8), 32);
  const ink = new Uint8Array(width * height);
  if (background >= 160) {
    for (let index = 0; index < grayscale.length; index += 1) {
      ink[index] = grayscale[index] < background - tolerance ? 1 : 0;
    }
  } else if (background <= 95) {
    for (let index = 0; index < grayscale.length; index += 1) {
      ink[index] = grayscale[index] > background + tolerance ? 1 : 0;
    }
  } else {
    for (let index = 0; index < grayscale.length; index += 1) {
      ink[index] = Math.abs(grayscale[index] - background) > tolerance ? 1 : 0;
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      if (!ink[index]) continue;
      const hasNeighbor =
        (x > 0 && ink[index - 1] !== 0) ||
        (x + 1 < width && ink[index + 1] !== 0) ||
        (y > 0 && ink[index - width] !== 0) ||
        (y + 1 < height && ink[index + width] !== 0);
      if (!hasNeighbor) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;

  minX = Math.max(0, minX - paddingPixels);
  minY = Math.max(0, minY - paddingPixels);
  maxX = Math.min(width, maxX + 1 + paddingPixels);
  maxY = Math.min(height, maxY + 1 + paddingPixels);
  if (minX <= 2 && minY <= 2 && width - maxX <= 2 && height - maxY <= 2) {
    return null;
  }
  return [minX / width, minY / height, maxX / width, maxY / height];
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  try {
    const rect = analyze(event.data);
    const response: AnalyzeResponse = { ok: true, rect };
    self.postMessage(response);
  } catch (error) {
    const response: AnalyzeResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
