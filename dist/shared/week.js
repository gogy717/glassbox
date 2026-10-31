/** The endpoint's path for a window. */
export const weekPath = (kind, refresh = false) => `/api/week?window=${kind}${refresh ? '&refresh=1' : ''}`;
export const HOUR_MS = 3_600_000;
/** Start of the local hour that holds `t`. */
export function hourStart(t) {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    return d.getTime();
}
/** Start of the local hour after the one starting at `h` (an hour later on any clock). */
export const nextHour = (h) => {
    const next = hourStart(h + HOUR_MS);
    return next > h ? next : h + HOUR_MS;
};
/** Local Monday 00:00 of the week holding `t`. */
export function weekStart(t) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
}
/** The hours of a window, counted from `now`: see `WeekWindow`. */
export function weekWindow(kind, now) {
    if (kind === '7d') {
        // Hours of the clock, not of the wall: 168 of them even where a change of the clocks moves
        // by half an hour (Lord Howe).
        const start = hourStart(now) - 167 * HOUR_MS;
        return { kind, hourStarts: Array.from({ length: 168 }, (_, i) => start + i * HOUR_MS), now };
    }
    const start = weekStart(now);
    const next = new Date(start);
    next.setDate(next.getDate() + 7);
    const hourStarts = [];
    for (let h = start; h < next.getTime(); h = nextHour(h))
        hourStarts.push(h);
    return { kind, hourStarts, now };
}
//# sourceMappingURL=week.js.map