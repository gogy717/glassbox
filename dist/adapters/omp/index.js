/**
 * oh-my-pi (omp) adapter: sessions, sub-agents and live state from the session files under
 * omp's agent dir (usually `~/.omp/agent`).
 */
import { join } from 'node:path';
import { classifyPath, discoverSessions, listSessionFiles, newCache, readArtifact, readLiveStatus, sessionWatchDirs, } from './discovery.js';
import { OmpSessionParser } from './parser.js';
export function createOmpAdapter({ ompDir, agentDir = join(ompDir, 'agent'), }) {
    const cache = newCache();
    let sources = [];
    /** Sub-agent ids seen per session, so the dirs their own sub-agents appear in are watched. */
    const subagents = new Map();
    const remember = (source, file) => {
        if (file?.role !== 'subagent' || !file.agentId)
            return;
        const ids = subagents.get(source.nativeId) ?? new Set();
        ids.add(file.agentId);
        subagents.set(source.nativeId, ids);
    };
    return {
        kind: 'oh-my-pi',
        discover: async () => {
            sources = await discoverSessions(agentDir, ompDir, cache);
            return sources;
        },
        listFiles: async (source) => {
            const files = await listSessionFiles(source);
            for (const file of files)
                remember(source, file);
            return files;
        },
        watchDirs: (source) => sessionWatchDirs(source, subagents.get(source.nativeId) ?? []),
        classify: (source, path) => {
            const file = classifyPath(source, path);
            remember(source, file);
            return file;
        },
        liveStatus: () => readLiveStatus(ompDir, sources, cache),
        createParser: (source) => new OmpSessionParser(source, {
            liveSignal: process.platform === 'linux',
            readArtifact: (id, agent) => readArtifact(source, id, agent),
        }),
    };
}
//# sourceMappingURL=index.js.map