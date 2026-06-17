/**
 * Figma Patch
 *
 * Patches Figma Desktop to enable remote debugging.
 * Newer Figma versions block --remote-debugging-port by default.
 */

import { readFileSync, writeFileSync, accessSync, constants } from 'fs';
import { execSync } from 'child_process';
import {
  getAsarPath as platformGetAsarPath,
  getFigmaBinaryPath as platformGetFigmaBinaryPath,
  getFigmaCommand as platformGetFigmaCommand
} from './platform.js';

// Fixed CDP port (figma-use has 9222 hardcoded)
const CDP_PORT = 9222;

/**
 * Get the CDP port (always 9222 for figma-use compatibility)
 */
export function getCdpPort() {
  return CDP_PORT;
}

// The string that blocks remote debugging
const BLOCK_STRING = Buffer.from('removeSwitch("remote-debugging-port")');
// The patched string (changes "port" to "Xort" to disable the block)
const PATCH_STRING = Buffer.from('removeSwitch("remote-debugXing-port")');

/**
 * Get the path to Figma's app.asar file
 */
export function getAsarPath() {
  return platformGetAsarPath();
}

/**
 * Check if Figma is patched
 * @returns {boolean|null} true=patched, false=not patched, null=can't determine
 */
export function isPatched() {
  const asarPath = getAsarPath();
  if (!asarPath) return null;

  try {
    const content = readFileSync(asarPath);

    if (content.includes(PATCH_STRING)) {
      return true; // Already patched
    }

    if (content.includes(BLOCK_STRING)) {
      return false; // Needs patching
    }

    return null; // Can't determine (maybe old Figma version)
  } catch {
    return null;
  }
}

/**
 * Check if we have write access to the Figma app.asar file
 * @returns {boolean} true if we can write, false otherwise
 */
export function canPatchFigma() {
  const asarPath = getAsarPath();
  if (!asarPath) return false;

  try {
    accessSync(asarPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Patch Figma to enable remote debugging
 * @returns {boolean} true if patched successfully
 */
export function patchFigma() {
  const asarPath = getAsarPath();
  if (!asarPath) {
    throw new Error('Cannot detect Figma installation path for this platform');
  }

  // Check write access first
  if (!canPatchFigma()) {
    if (process.platform === 'darwin') {
      throw new Error('No write access to Figma. On macOS 13+ grant your terminal "App Management" (System Settings → Privacy & Security → App Management) — "Full Disk Access" alone does not allow modifying another app. Or use Safe Mode: figma-cli connect --safe');
    } else {
      throw new Error('No write access to Figma. Try running as administrator.');
    }
  }

  const content = readFileSync(asarPath);
  const blockIndex = content.indexOf(BLOCK_STRING);

  if (blockIndex < 0) {
    // Check if already patched
    if (content.includes(PATCH_STRING)) {
      return true; // Already patched
    }
    throw new Error('Could not find the string to patch. Figma version may be incompatible.');
  }

  // Apply patch
  PATCH_STRING.copy(content, blockIndex);
  writeFileSync(asarPath, content);

  // On macOS, re-sign the app
  if (process.platform === 'darwin') {
    try {
      execSync('codesign --force --deep --sign - /Applications/Figma.app', { stdio: 'ignore' });
    } catch {
      // Codesign might fail but patch might still work
    }
  }

  return true;
}

/**
 * Unpatch Figma to restore original state (re-enables remote debugging block)
 * @returns {boolean} true if unpatched successfully
 */
export function unpatchFigma() {
  const asarPath = getAsarPath();
  if (!asarPath) {
    throw new Error('Cannot detect Figma installation path for this platform');
  }

  const content = readFileSync(asarPath);
  const patchIndex = content.indexOf(PATCH_STRING);

  if (patchIndex < 0) {
    // Check if already unpatched (original state)
    if (content.includes(BLOCK_STRING)) {
      return true; // Already in original state
    }
    throw new Error('Could not find the patched string. Figma may not have been patched by this tool.');
  }

  // Restore original
  BLOCK_STRING.copy(content, patchIndex);
  writeFileSync(asarPath, content);

  // On macOS, re-sign the app
  if (process.platform === 'darwin') {
    try {
      execSync('codesign --force --deep --sign - /Applications/Figma.app', { stdio: 'ignore' });
    } catch {
      // Codesign might fail but unpatch might still work
    }
  }

  return true;
}

/**
 * Get the command to start Figma with remote debugging
 */
export function getFigmaCommand(port = 9222) {
  return platformGetFigmaCommand(port);
}

/**
 * Get the path to Figma binary
 */
export function getFigmaBinaryPath() {
  return platformGetFigmaBinaryPath();
}

export default {
  getAsarPath,
  isPatched,
  canPatchFigma,
  patchFigma,
  unpatchFigma,
  getFigmaCommand,
  getFigmaBinaryPath,
  getCdpPort
};
