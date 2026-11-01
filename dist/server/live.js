/** busy and waiting both mean someone is mid-task in that session right now. */
export function isActive(live) {
    return live === 'busy' || live === 'waiting';
}
//# sourceMappingURL=live.js.map