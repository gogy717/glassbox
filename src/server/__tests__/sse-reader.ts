import type { ServerEvent } from '../../shared/protocol.js';

/** Reads SSE messages from a response body, one parsed event per call. */
export function sseReader(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    async next(): Promise<{ event: string; data: ServerEvent }> {
      for (;;) {
        const end = buf.indexOf('\n\n');
        if (end !== -1) {
          const raw = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? '';
          const data = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.replace(/^data: ?/, ''))
            .join('\n');
          return { event, data: JSON.parse(data) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}
