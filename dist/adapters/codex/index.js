import { busySessions, carryClaims, classifyScanned, newLiveClaims, readEncoded, scanCodexDir, watchDirsFor, } from './discovery.js';
import { CodexSessionParser } from './parser.js';
import { readCodexQuota } from './quota.js';
export function createCodexAdapter({ codexDir }, io) {
    let scan = null;
    const heads = new Map();
    let claims = newLiveClaims();
    let started = 0;
    let applied = 0;
    const load = async () => {
        const seq = ++started;
        const next = await scanCodexDir(codexDir, io, heads);
        // Scans overlap (discovery, and a rebuild's listFiles): an older one must not win.
        if (seq > applied) {
            applied = seq;
            claims = carryClaims(claims, scan, next);
            scan = next;
        }
        return next;
    };
    return {
        kind: 'codex',
        discover: async () => (await load()).sources,
        // Scanned afresh: the server asks again after a file vanished, e.g. compressed in place.
        listFiles: async (source) => (await load()).files.get(source.nativeId) ?? [],
        watchDirs: (source) => watchDirsFor(scan, codexDir, source),
        classify: (source, path) => (scan ? classifyScanned(scan, source, path, claims, heads) : null),
        liveStatus: async () => busySessions(scan ?? (await load())),
        readFile: (file) => readEncoded(file, io),
        // Polled, not watched: the newest rollout changes as sessions come and go.
        quota: async () => readCodexQuota(scan ?? (await load())),
        createParser: (source) => {
            const parser = new CodexSessionParser(source);
            if (scan && (scan.flagAll || scan.unreadable.has(source.nativeId))) {
                parser.markArchivesUnavailable();
            }
            return parser;
        },
    };
}
//# sourceMappingURL=index.js.map