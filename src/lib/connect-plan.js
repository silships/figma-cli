/**
 * Deciding what `connect --desktop` (Yolo Mode) has to do to Figma Desktop
 * before it can talk to it.
 *
 * Lives in its own module so the decision can be unit-tested: the connect
 * command itself probes the CDP port and the process list, neither of which
 * is available in a test run.
 */

/**
 * Who answers on the CDP port, from its /json/version payload.
 *
 * Browser Mode puts a debug Chrome on the SAME port (getCdpPort()), so a
 * reachable port alone does not prove Figma Desktop is debuggable. Figma
 * Desktop is Electron: its User-Agent carries "Figma" and "Electron".
 *
 * @param {object|null} version  parsed /json/version, or null when unreachable
 * @returns {'desktop'|'other'|null}
 */
export function cdpOwner(version) {
  if (!version) return null;
  const ua = String(version['User-Agent'] || '') + ' ' + String(version.Browser || '');
  return /Figma|Electron/.test(ua) ? 'desktop' : 'other';
}

/**
 * What Yolo `connect` should do, given what is currently running.
 *
 * `connect` used to quit and relaunch Figma unconditionally. That costs the
 * user their window arrangement and any unsaved state every time they run it,
 * including the common case where Figma is already reachable.
 *
 * @param {object} state
 * @param {'desktop'|'other'|null} state.cdp  who answers on the CDP port
 * @param {boolean} state.figmaRunning  a Figma Desktop process exists
 * @returns {'reuse'|'port-busy'|'needs-quit'|'start-fresh'}
 *   `reuse`       Figma Desktop is already debuggable: leave it alone.
 *   `port-busy`   something else (the Browser Mode Chrome) holds the port.
 *                 Figma Desktop could not bind it, so tell the user.
 *   `needs-quit`  Figma runs without the debug port. Only the user can quit
 *                 it safely (unsaved work), so ask instead of killing it.
 *   `start-fresh` no Figma at all: launch it ourselves.
 */
export function resolveConnectAction({ cdp, figmaRunning }) {
  if (cdp === 'desktop') return 'reuse';
  if (cdp === 'other') return 'port-busy';
  if (figmaRunning) return 'needs-quit';
  return 'start-fresh';
}
