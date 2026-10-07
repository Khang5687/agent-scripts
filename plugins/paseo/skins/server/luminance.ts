export interface Luminance {
  low: number;
  high: number;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8Array;
}

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

const LINEAR_TABLE = Float64Array.from({ length: 256 }, (_, channel) => toLinear(channel));

/** WCAG 2.x relative luminance of an 8-bit sRGB color. */
export function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * LINEAR_TABLE[red]! + 0.7152 * LINEAR_TABLE[green]! + 0.0722 * LINEAR_TABLE[blue]!;
}

/** Relative luminance of the darkest 1% and brightest 1% of opaque pixels (nearest rank). */
export function luminancePercentiles(pixels: Pixels): Luminance | null {
  const values: number[] = [];
  for (let offset = 0; offset + 3 < pixels.data.length; offset += 4) {
    if (pixels.data[offset + 3] === 0) continue;
    values.push(relativeLuminance(pixels.data[offset]!, pixels.data[offset + 1]!, pixels.data[offset + 2]!));
  }
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  const last = values.length - 1;
  return { low: values[Math.floor(last * 0.01)]!, high: values[Math.ceil(last * 0.99)]! };
}
