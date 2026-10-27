const enc = encodeURIComponent;
/** All POST/DELETE routes require the `TOKEN_HEADER` header (see protocol.ts). */
export const runsApi = {
    /** POST StartRunRequest → StartRunResponse. GET → RunState[]. */
    runs: () => '/api/runs',
    /** POST SendMessageRequest → 204. 409 while the run is not idle. */
    message: (runId) => `/api/runs/${enc(runId)}/messages`,
    /** POST → 204. */
    interrupt: (runId) => `/api/runs/${enc(runId)}/interrupt`,
    /** DELETE → 204. Ends the run's process. */
    run: (runId) => `/api/runs/${enc(runId)}`,
    /** POST PermissionDecision → 204. */
    permission: (runId, permissionId) => `/api/runs/${enc(runId)}/permissions/${enc(permissionId)}`,
    /** GET → DirectoriesResponse. */
    directories: () => '/api/directories',
};
//# sourceMappingURL=runs.js.map