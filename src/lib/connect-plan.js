/**
 * Deciding what `connect` has to do to Figma before it can talk to it.
 *
 * Lives in its own module so the decision can be unit-tested: the connect
 * command itself probes the CDP port and the process list, neither of which
 * is available in a test run.
 */

/**
 * What `connect` should do, given what is currently running.
 *
 * `connect` used to quit and relaunch Figma unconditionally. That costs the
 * user their window arrangement and any unsaved state every time they run it —
 * including the common case where Figma is already reachable and nothing needs
 * to happen to it at all.
 *
 * @param {object} state
 * @param {boolean} state.cdpReachable  the CDP port answered
 * @param {boolean} state.figmaRunning  a Figma process exists
 * @returns {'reuse'|'needs-quit'|'start-fresh'}
 *   `reuse`       — Figma is already debuggable; leave it alone, just wire up the daemon.
 *   `needs-quit`  — Figma runs without the debug port. Only the user can quit it
 *                   safely (unsaved work), so ask instead of killing it.
 *   `start-fresh` — no Figma at all; patch if needed and launch it ourselves.
 */
export function resolveConnectAction({ cdpReachable, figmaRunning }) {
  if (cdpReachable) return 'reuse';
  if (figmaRunning) return 'needs-quit';
  return 'start-fresh';
}
