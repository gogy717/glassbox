import { type FileHandle, open, readFile } from 'node:fs/promises';

export interface TailRead {
  /** Complete lines (no line terminator), blank lines skipped. */
  lines: string[];
  /** The file was truncated or replaced since the last read; `lines` start from offset 0. */
  reset: boolean;
  /** Bytes remain past what this call read (only when `maxBytes` cut it short). */
  more: boolean;
  /**
   * The file was read before and is missing now: what came from it may no longer hold (it may
   * have been archived under another name). Absent otherwise.
   */
  gone?: true;
}

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/**
 * Incremental reader for an append-only jsonl file.
 *
 * Agents write whole lines, but a read can land between two `write`s, so the unterminated
 * tail is buffered (as bytes, so a multi-byte character split across reads survives) until
 * its newline arrives. A shrinking size or a new inode means the file was rewritten, and
 * reading restarts from 0. A same-inode rewrite that ends up at least as long as before is
 * indistinguishable from an append and is not detected.
 */
export class JsonlTailer {
  private offset = 0;
  private ino: number | null = null;
  private partial: Buffer = EMPTY;
  /** The file vanished after we had read from it; whatever appears next is a new file. */
  private vanished = false;

  constructor(readonly path: string) {}

  async read(maxBytes = Number.POSITIVE_INFINITY): Promise<TailRead> {
    let fh: FileHandle;
    try {
      fh = await open(this.path, 'r');
    } catch (err) {
      if (isNotFound(err)) {
        if (this.offset > 0 || this.partial.length > 0) this.vanished = true;
        return this.vanished
          ? { lines: [], reset: false, more: false, gone: true }
          : { lines: [], reset: false, more: false };
      }
      throw err;
    }
    try {
      const st = await fh.stat();
      let reset = false;
      if (this.vanished || (this.ino !== null && st.ino !== this.ino) || st.size < this.offset) {
        reset = this.offset > 0 || this.partial.length > 0;
        this.offset = 0;
        this.partial = EMPTY;
        this.vanished = false;
      }
      this.ino = st.ino;

      const want = Math.min(st.size - this.offset, maxBytes);
      const chunk = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(chunk, got, want - got, this.offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      this.offset += got;
      const lines = this.split(chunk.subarray(0, got));
      return { lines, reset, more: this.offset < st.size };
    } finally {
      await fh.close();
    }
  }

  private split(chunk: Buffer): string[] {
    const buf = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (let nl = buf.indexOf(NEWLINE, start); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
      const end = nl > start && buf[nl - 1] === 0x0d ? nl - 1 : nl;
      const line = buf.toString('utf8', start, end);
      if (line.trim() !== '') lines.push(line);
      start = nl + 1;
    }
    // Copy so the retained tail does not pin the whole chunk in memory.
    this.partial = start < buf.length ? Buffer.from(buf.subarray(start)) : EMPTY;
    return lines;
  }
}

/** A json file's text and parsed value; undefined when missing or not (yet) valid JSON. */
export async function readJsonFile(
  path: string,
): Promise<{ text: string; value: unknown } | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return { text, value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
