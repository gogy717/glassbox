const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * The runs of lines the patch removed and put in, context left out, in the file as the edit
 * found it. Null when the result holds no patch (an error, another tool) or the file was
 * created: a new file is all new, not a run of lines.
 */
export function lineChangesOf(toolUseResult) {
    if (!isObj(toolUseResult) || toolUseResult.type === 'create')
        return null;
    const hunks = toolUseResult.structuredPatch;
    if (!Array.isArray(hunks))
        return null;
    const out = [];
    for (const hunk of hunks) {
        if (!isObj(hunk) || typeof hunk.oldStart !== 'number' || !Array.isArray(hunk.lines))
            continue;
        let line = Math.max(1, hunk.oldStart);
        let run = null;
        for (const text of hunk.lines) {
            if (typeof text !== 'string')
                continue;
            const mark = text[0];
            // "\ No newline at end of file" belongs to the line before it.
            if (mark === '\\')
                continue;
            if (mark === '-' || mark === '+') {
                if (!run) {
                    run = [line, 0, 0];
                    out.push(run);
                }
                if (mark === '-') {
                    run[1]++;
                    line++;
                }
                else
                    run[2]++;
            }
            else {
                run = null;
                line++;
            }
        }
    }
    return out;
}
//# sourceMappingURL=line-changes.js.map