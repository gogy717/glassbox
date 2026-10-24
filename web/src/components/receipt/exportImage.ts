/**
 * The receipt leaves as a PNG drawn in this browser: the SVG (fonts inside it) becomes an image,
 * the image a canvas at 3×, the canvas a PNG. No request is made on the way.
 */
import type { ReceiptData } from './data';
import { stamp } from './format';
import { SCALE } from './svg';

/** The SVG as a data: URL, the one image source the page's CSP allows besides its own files. */
export const svgUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The SVG as a PNG at `SCALE` times its size. */
export async function rasterize(svg: string, width: number, height: number): Promise<Blob> {
  const img = new Image();
  img.src = svgUrl(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no PNG'))), 'image/png'),
  );
}

/** Saves `blob` as `name` through a link, as a download. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Whether this browser can put an image on the clipboard (Firefox long could not). */
export const canCopyImage = () =>
  typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

/**
 * Puts the PNG on the clipboard. The item is made in the click's own turn, with the PNG still
 * to come, which is what Safari needs; resolves when it is there.
 */
export function copyImage(png: Promise<Blob>): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** glassbox-receipt-<project>-<yyyymmdd-hhmm>.png; without the project when names are hidden. */
export function fileName(d: ReceiptData, hideNames: boolean): string {
  const project = hideNames
    ? ''
    : d.project.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `glassbox-receipt-${project ? `${project}-` : ''}${stamp(d.start ?? d.end)}.png`;
}
