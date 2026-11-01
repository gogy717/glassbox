/**
 * Live state from oh-my-pi's session lease.
 *
 * While a process has a session open it holds a lease on it (`claimSession`). On Linux the lease
 * is an abstract Unix socket named `omp-file-lock-<xxh64 hi><xxh64 lo>`, the two hashes taken
 * of `<omp dir>/run/session-owners/<session id>.lock` with omp's fixed seeds. The kernel drops
 * it when the process exits, crashed or not, and `/proc/net/unix` lists it while it lives. That
 * is read here, nothing is bound or locked. Elsewhere the lease is a `flock` sidecar (macOS) or a
 * named mutex (Windows), which cannot be seen without taking it, so live state stays 'closed'.
 *
 * A held lease means the process is there; the session's tail tells busy from idle.
 */
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseOmpLine } from './records.js';
const M64 = (1n << 64n) - 1n;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & M64;
const round = (acc, lane) => (rotl((acc + lane * P2) & M64, 31n) * P1) & M64;
const merge = (acc, v) => ((acc ^ round(0n, v)) * P1 + P4) & M64;
/** XXH64 of `buf`, as omp's native lock names it (`xxhash_rust::xxh64`). */
export function xxh64(buf, seed) {
    const len = buf.length;
    let i = 0;
    let h;
    if (len >= 32) {
        let v1 = (seed + P1 + P2) & M64;
        let v2 = (seed + P2) & M64;
        let v3 = seed & M64;
        let v4 = (seed - P1) & M64;
        for (; i + 32 <= len; i += 32) {
            v1 = round(v1, buf.readBigUInt64LE(i));
            v2 = round(v2, buf.readBigUInt64LE(i + 8));
            v3 = round(v3, buf.readBigUInt64LE(i + 16));
            v4 = round(v4, buf.readBigUInt64LE(i + 24));
        }
        h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
        h = merge(merge(merge(merge(h, v1), v2), v3), v4);
    }
    else
        h = (seed + P5) & M64;
    h = (h + BigInt(len)) & M64;
    for (; i + 8 <= len; i += 8)
        h = (rotl(h ^ round(0n, buf.readBigUInt64LE(i)), 27n) * P1 + P4) & M64;
    if (i + 4 <= len) {
        h = (rotl(h ^ ((BigInt(buf.readUInt32LE(i)) * P1) & M64), 23n) * P2 + P3) & M64;
        i += 4;
    }
    for (; i < len; i++)
        h = (rotl(h ^ ((BigInt(buf[i]) * P5) & M64), 11n) * P1) & M64;
    h ^= h >> 33n;
    h = (h * P2) & M64;
    h ^= h >> 29n;
    h = (h * P3) & M64;
    return h ^ (h >> 32n);
}
/** omp's seeds: "OMP-LOCK" and "PI-FILEL" as big-endian u64. */
const HIGH_SEED = 0x4f4d502d4c4f434bn;
const LOW_SEED = 0x50492d46494c454cn;
/** Session ids omp uses as the lease name as is; any other id is hashed with Bun's wyhash. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Abstract socket name of the lease on session `id`; null when omp would hash the id. */
export function leaseName(ompDir, id) {
    if (!PLAIN_ID.test(id))
        return null;
    const path = Buffer.from(`${resolve(ompDir, 'run', 'session-owners', id)}.lock`, 'utf8');
    const hex = (n) => n.toString(16).padStart(16, '0');
    return `omp-file-lock-${hex(xxh64(path, HIGH_SEED))}${hex(xxh64(path, LOW_SEED))}`;
}
/** Names of the omp locks held on this machine; null where they cannot be seen. */
export async function heldLeases(table = '/proc/net/unix', platform = process.platform) {
    if (platform !== 'linux')
        return null;
    let text;
    try {
        text = await readFile(table, 'utf8');
    }
    catch {
        return null;
    }
    return new Set([...text.matchAll(/@(omp-file-lock-[0-9a-f]{32})\b/g)].map((m) => m[1]));
}
/** Bytes read from the end of a session file to find its last message. */
const TAIL_BYTES = 64 * 1024;
/**
 * Busy or idle from the last message in a session file: the agent is done when its last answer
 * did not ask for tools; a prompt, a tool result or a background result after it is being worked
 * on. Other injected input (reminders, mode context) can sit there until the next prompt, so it
 * does not count. Null when the file cannot be read.
 */
export async function activityOf(path) {
    let text;
    try {
        const fh = await open(path, 'r');
        try {
            const { size } = await fh.stat();
            const start = Math.max(0, size - TAIL_BYTES);
            const buf = Buffer.alloc(size - start);
            await fh.read(buf, 0, buf.length, start);
            text = buf.toString('utf8');
            if (start > 0)
                text = text.slice(text.indexOf('\n') + 1);
        }
        finally {
            await fh.close();
        }
    }
    catch {
        return null;
    }
    let state = 'idle';
    for (const line of text.split('\n')) {
        const rec = parseOmpLine(line);
        if (rec.kind !== 'entry')
            continue;
        const { body } = rec;
        if (body.kind === 'assistant')
            state = body.stopReason === 'toolUse' ? 'busy' : 'idle';
        else if (body.kind === 'user' || body.kind === 'tool-result')
            state = 'busy';
        else if (body.kind === 'injected' && body.customType === 'async-result')
            state = 'busy';
    }
    return state;
}
//# sourceMappingURL=live.js.map