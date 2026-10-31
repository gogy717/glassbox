import { isActive } from './live.js';
export const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
/** Busy or waiting: it may be working in files its `updatedAt` does not follow. */
export const running = (s) => isActive(s.live);
/**
 * Of a window's sessions, those not known to be as cached: not read yet, changed since (by their
 * `updatedAt`), running now, or running when they were read.
 */
export function staleSessions(wanted, cache) {
    return wanted.filter((s) => {
        const c = cache.get(s.id);
        return !c || running(s) || c.running || c.updatedAt !== s.updatedAt;
    });
}
/** One very large read at a time: the next waits for the last to settle. */
export class BigReads {
    last = Promise.resolve();
    /** Runs `read`, after the last big one when `big`. */
    async run(big, read) {
        if (!big)
            return read();
        const before = this.last;
        let release = () => { };
        this.last = new Promise((resolve) => {
            release = resolve;
        });
        await before;
        try {
            return await read();
        }
        finally {
            release();
        }
    }
}
/** Reads the stale sessions that need it into the caller's cache, and counts the reading. */
export async function readWindowSessions(o) {
    // Open sessions are read again from memory every time; a running one that has to be parsed,
    // no sooner than `reparseMs` after its last parse, unless a refresh asks.
    const sizeOf = o.store.sizeOf?.bind(o.store);
    const sized = await Promise.all(o.stale.map(async (s) => ({ s, size: sizeOf ? await sizeOf(s.id).catch(() => 0) : 0 })));
    const toRead = sized.filter(({ s, size }) => {
        const c = o.cache.get(s.id);
        return !c || o.refresh || size === 0 || !(running(s) && o.now - c.readAt < o.reparseMs);
    });
    if (toRead.length < sized.length)
        o.advance(sized.length - toRead.length);
    // The smallest first: a large session waits for the small ones, never the other way.
    toRead.sort((a, b) => a.size - b.size);
    const readOne = (s, size) => o.bigReads.run(size >= o.bigBytes, async () => {
        if (o.stopped())
            return null;
        const got = await o.store.readSession(s.id);
        if (!got || o.stopped())
            return null;
        return (await o.keep(s, got, o.now)) ? got.bytes : null;
    });
    const counts = { tried: toRead.length, read: 0, failed: 0, bytes: 0 };
    let next = 0;
    const worker = async () => {
        for (let item = toRead[next++]; item && !o.stopped(); item = toRead[next++]) {
            const { s, size } = item;
            try {
                const got = await readOne(s, size);
                if (got === null)
                    counts.failed++;
                else {
                    counts.bytes += got;
                    counts.read++;
                }
            }
            catch (err) {
                counts.failed++;
                o.log(`${o.label}: could not read ${s.id}: ${err instanceof Error ? err.message : err}`);
            }
            o.advance(1);
            // Between sessions, let the live view's requests and events through.
            await yieldToLoop();
        }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency, toRead.length) }, worker));
    return counts;
}
//# sourceMappingURL=window-sessions.js.map