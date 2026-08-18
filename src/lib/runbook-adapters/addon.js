// src/lib/runbook-adapters/addon.js
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

function _titleCase(str) {
  return str
    .split('-')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

async function _loadSidecar(name, projectRoot) {
  const path = join(projectRoot, 'addons', name, 'runbook.js');
  try {
    return await import(path);
  } catch {
    return null;
  }
}

export const AddonAdapter = {
  /**
   * Return list of addon names that have a runbook.js sidecar in projectRoot.
   * @param {string} [projectRoot]
   * @returns {Promise<string[]>}
   */
  async knownAddons(projectRoot = process.cwd()) {
    const addonsDir = join(projectRoot, 'addons');
    if (!existsSync(addonsDir)) return [];
    try {
      const entries = await readdir(addonsDir, { withFileTypes: true });
      const names = [];
      for (const entry of entries) {
        if (entry.isDirectory() && existsSync(join(addonsDir, entry.name, 'runbook.js'))) {
          names.push(entry.name);
        }
      }
      return names;
    } catch {
      return [];
    }
  },

  /**
   * Env vars required for an addon (credential-type vars shown in the credentials table).
   * @param {string} name
   * @param {object|null} cfg
   * @param {string} [projectRoot]
   * @returns {Promise<Array<{name: string, required: boolean|string, description: string}>>}
   */
  async envVarsFor(name, cfg = null, projectRoot = process.cwd()) {
    const sidecar = await _loadSidecar(name, projectRoot);
    return sidecar?.envVarsFor(cfg) ?? [];
  },

  /**
   * Env export objects for the consolidated bash block.
   * @param {string} name
   * @param {object|null} cfg
   * @param {string} [projectRoot]
   * @returns {Promise<Array<{key: string, value: string, group: string}>>}
   */
  async envExportsFor(name, cfg = null, projectRoot = process.cwd()) {
    const sidecar = await _loadSidecar(name, projectRoot);
    return sidecar?.envExportsFor(cfg) ?? [];
  },

  /**
   * Generate a markdown section for an addon installation.
   * @param {string} name
   * @param {number} [subIndex]
   * @param {object|null} [cfg]
   * @param {string} [projectRoot]
   * @returns {Promise<string>}
   */
  async generate(name, subIndex = 0, cfg = null, projectRoot = process.cwd()) {
    const sidecar = await _loadSidecar(name, projectRoot);
    if (!sidecar) {
      return `### ${_titleCase(name)}\n\n_No \`runbook.js\` sidecar found for addon \`${name}\`._`;
    }
    return sidecar.generate(subIndex, cfg);
  },

  /**
   * Generate a markdown cleanup snippet for an addon.
   * Returns null if the addon has no cleanup export.
   * @param {string} name
   * @param {object|null} [cfg]
   * @param {string} [projectRoot]
   * @returns {Promise<string|null>}
   */
  async cleanupFor(name, cfg = null, projectRoot = process.cwd()) {
    const sidecar = await _loadSidecar(name, projectRoot);
    if (!sidecar?.cleanup) return null;
    return sidecar.cleanup(cfg);
  },
};
