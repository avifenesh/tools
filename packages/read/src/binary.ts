import path from "node:path";
import { BINARY_EXTENSIONS } from "./constants.js";

export function isBinaryByExtension(filepath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filepath).toLowerCase());
}

export function isBinaryByContent(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i] as number;
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

export function isBinary(filepath: string, sample: Uint8Array): boolean {
  return isBinaryByExtension(filepath) || isBinaryByContent(sample);
}

export function isImageMime(mime: string): boolean {
  if (!mime.startsWith("image/")) return false;
  if (mime === "image/svg+xml") return false;
  return true;
}

export function isPdfMime(mime: string): boolean {
  return mime === "application/pdf";
}
