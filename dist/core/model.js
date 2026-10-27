/**
 * Agent-neutral data model.
 *
 * Adapters translate each agent's native session records into these entities; the server
 * and the web UI only ever see these types. Every entity is keyed by a string id so live
 * updates can be applied as upserts.
 *
 * CONTRACT: every adapter, the server and the web UI depend on this file; change it on its
 * own, with all of them updated together.
 */
/** Id of the root agent of every session. */
export const MAIN_AGENT_ID = 'main';
//# sourceMappingURL=model.js.map