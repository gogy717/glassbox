/**
 * The receipt leaves as a PNG drawn in this browser: the SVG (fonts inside it) becomes an image,
 * the image a canvas at 3×, the canvas a PNG. No request is made on the way.
 */
import type { ReceiptData } from './data';
import { isoWeek, stamp } from './format';
import { SCALE } from './svg';
import type { WeekReceipt } from './week';

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
  a.hidden = true;
  document.body.append(a);
  a.click();
  // Firefox and Safari start the download after the click returns: keep both a while.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
}

/**
 * Puts the PNG on the clipboard, or, where the clipboard cannot take an image or refuses it (a
 * permission, a browser without ClipboardItem, a throw), downloads the same PNG instead. The
 * item is made in the click's own turn, the PNG still to come, which is what Safari needs.
 */
export function copyOrDownload(png: Promise<Blob>, name: string): Promise<'copied' | 'downloaded'> {
  let write: Promise<void>;
  try {
    if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function')
      throw new Error('no image clipboard');
    write = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (err) {
    write = Promise.reject(err);
  }
  return write.then(
    () => 'copied' as const,
    async () => {
      download(await png, name);
      return 'downloaded' as const;
    },
  );
}

/** glassbox-receipt-<project>-<yyyymmdd-hhmm>.png; without the project when names are hidden. */
export function fileName(d: ReceiptData, hideNames: boolean): string {
  const project =
    hideNames || !d.project
      ? ''
      : d.project.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `glassbox-receipt-${project ? `${project}-` : ''}${stamp(d.start ?? d.end)}.png`;
}

/** glassbox-week-2026-W43.png for this week, glassbox-7days-20261024.png for the last 7 days. */
export function weekFileName(d: WeekReceipt): string {
  if (d.kind === '7d') return `glassbox-7days-${stamp(d.now).slice(0, 8)}.png`;
  const [year, week] = isoWeek(d.start);
  return `glassbox-week-${year}-W${String(week).padStart(2, '0')}.png`;
}
