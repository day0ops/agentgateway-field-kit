import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { Prompts } from './prompts.js';
import { EnvironmentManager } from './environment.js';
import { ProfileSchema } from './profile-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

/**
 * Profile management utilities
 * Handles agentgateway installation profiles with extensible service support
 */
export class ProfileManager {
  static PROFILES_DIR = join(PROJECT_ROOT, 'config/profiles');

  static formatChoiceLabel(name, description) {
    const lines = (description || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return name;
    }

    const detailIndent = '    ';
    const formattedDetails = lines.map(line => {
      const text = line.startsWith('- ') ? line.slice(2) : line;
      return `${detailIndent}• ${text}`;
    });

    return [name, ...formattedDetails].join('\n');
  }

  static formatListEntry(name, description, { indent = 2 } = {}) {
    return ProfileManager.formatChoiceLabel(name, description)
      .split('\n')
      .map(line => `${' '.repeat(indent)}${chalk.cyan(line)}`)
      .join('\n');
  }

  /**
   * Get all available profiles
   * @param {string} [root] - Optional project root directory. Defaults to this project's root.
   * @returns {Promise<Array<{name: string, file: string, description: string}>>}
   */
  static async list(root) {
    const dir = root ? join(root, 'config', 'profiles') : this.PROFILES_DIR;
    if (!existsSync(dir)) {
      return [];
    }
    try {
      const files = await readdir(dir);
      const yamlFiles = files.filter(f => f.endsWith('.yaml'));
      const profiles = [];

      for (const file of yamlFiles) {
        const name = basename(file, '.yaml');
        const filePath = join(dir, file);
        let description = '';

        try {
          const content = await readFile(filePath, 'utf8');
          const profile = yaml.load(content);
          description = ProfileSchema.getDescription(profile) || '';
        } catch {
          // keep empty description
        }

        profiles.push({
          name,
          file: filePath,
          description,
        });
      }

      return profiles;
    } catch (error) {
      throw new Error(`Failed to list profiles: ${error.message}`);
    }
  }

  /**
   * Load and parse a profile file with environment template resolution
   * @param {string} profilePath - Path to profile YAML file
   * @returns {Promise<{helmValues: object, addons: Array, resources: Array}>}
   */
  static async load(profilePath) {
    try {
      const content = await readFile(profilePath, 'utf8');
      const raw = yaml.load(content);
      let profile = ProfileSchema.normalize(raw, profilePath);

      // Resolve environment templates if profile specifies an environment
      if (profile.environment) {
        try {
          const environment = await EnvironmentManager.load(profile.environment);
          profile = EnvironmentManager.resolveAllTemplates(profile, environment);
        } catch (envError) {
          // If environment loading fails, continue without resolution
          // This allows profiles without environments to work
          if (!envError.message.includes('not found')) {
            throw envError;
          }
        }
      }

      return {
        ...profile,
        helmValues: profile.helmValues || {},
        addons: profile.addons || [],
        resources: profile.resources || [],
        infra: profile.infra || null,
      };
    } catch (error) {
      throw new Error(`Failed to load profile: ${error.message}`);
    }
  }

  /**
   * Prompt user to select a profile
   * @param {string} defaultProfile - Default profile name
   * @returns {Promise<{name: string, file: string}>} Selected profile
   */
  static async select(defaultProfile = 'standard') {
    try {
      const profiles = await this.list();

      if (profiles.length === 0) {
        throw new Error('No profiles found in config/profiles/');
      }

      const choices = profiles
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(profile => ({
          name: ProfileManager.formatChoiceLabel(profile.name, profile.description),
          value: profile.name,
          short: profile.name,
        }));

      const selectedName = await Prompts.select(
        'Select installation profile:',
        choices,
        defaultProfile
      );

      const profile = profiles.find(p => p.name === selectedName);

      return {
        name: profile.name,
        file: profile.file,
      };
    } catch (error) {
      throw new Error(`Failed to select profile: ${error.message}`);
    }
  }
}
