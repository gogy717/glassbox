import { classifyPath, discoverSessions, listSessionFiles, readLiveStatus, sessionWatchDirs, } from './discovery.js';
import { GrokSessionParser } from './parser.js';
export function createGrokAdapter({ grokDir }) {
    const live = { pidOk: new Map() };
    return {
        kind: 'grok',
        // Grok writes a turn's tokens when the turn ends (turn_completed, usage.json); nothing
        // during it.
        usageReporting: 'turn',
        discover: () => discoverSessions(grokDir, live),
        listFiles: listSessionFiles,
        watchDirs: sessionWatchDirs,
        classify: classifyPath,
        liveStatus: () => readLiveStatus(grokDir, live),
        createParser: (source) => new GrokSessionParser(source),
    };
}
//# sourceMappingURL=index.js.map