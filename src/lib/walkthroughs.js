import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { WalkthroughSchema } from './walkthrough-schema.js';
import { EnvironmentManager } from './environment.js';
import { FeatureManager } from './feature.js';
import { resolveEdition } from './editions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

/** Discovers and loads Walkthrough documents. */
export class WalkthroughManager {
  static WALKTHROUGHS_DIR = join(PROJECT_ROOT, 'config/walkthroughs');

  static async list(root) {
    const dir = root ? join(root, 'config', 'walkthroughs') : this.WALKTHROUGHS_DIR;
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const yamlFiles = files.filter(f => f.endsWith('.yaml'));
    const walkthroughs = [];

    for (const file of yamlFiles) {
      const name = basename(file, '.yaml');
      const filePath = join(dir, file);
      let description = '';
      try {
        const content = await readFile(filePath, 'utf8');
        const doc = yaml.load(content);
        description = WalkthroughSchema.getDescription(doc) || '';
      } catch {
        // keep empty description
      }
      walkthroughs.push({ name, file: filePath, description });
    }

    return walkthroughs.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Verifies every feature a walkthrough references supports its resolved edition.
   * @throws {Error} naming the first unsupported feature
   */
  static validateFeatureEditions(walkthroughName, edition, featureRefs) {
    for (const { name } of featureRefs) {
      const supported = FeatureManager.getSupportedEditions(name);
      if (!supported.includes(edition)) {
        throw new Error(
          `Walkthrough '${walkthroughName}' declares edition '${edition}' but feature '${name}' only supports: ${supported.join(', ')}.`
        );
      }
    }
  }

  /**
   * Loads a Walkthrough document, resolving its environment's templates if `spec.environment`
   * is set, and validating every referenced feature against the resolved edition.
   * @returns {Promise<object>} the resolved walkthrough, with `screens`, `credentials`,
   *   `preProvision` always present, and `edition` always a resolved 'enterprise'|'opensource'.
   */
  static async load(walkthroughFile) {
    const content = await readFile(walkthroughFile, 'utf8');
    const raw = yaml.load(content);
    let walkthrough = WalkthroughSchema.normalize(raw, walkthroughFile);

    if (walkthrough.environment) {
      const environment = await EnvironmentManager.load(walkthrough.environment);
      walkthrough = EnvironmentManager.resolveAllTemplates(walkthrough, environment);
    }

    // Default each screen's steps to [] (e.g. a narration-only intro/outro screen) - the schema
    // doesn't require steps to be non-empty, so downstream consumers must not assume one exists.
    const screens = (walkthrough.screens || []).map(screen => ({
      ...screen,
      steps: screen.steps || [],
    }));
    const edition = resolveEdition(walkthrough.edition);
    const preProvision = walkthrough.preProvision || [];
    const allFeatureRefs = [
      ...preProvision,
      ...screens.flatMap(screen => [...(screen.teardown || []), ...(screen.setup || [])]),
    ];
    this.validateFeatureEditions(WalkthroughSchema.getName(raw), edition, allFeatureRefs);

    return {
      ...walkthrough,
      screens,
      credentials: walkthrough.credentials || {},
      preProvision,
      edition,
      namespace: walkthrough.namespace,
    };
  }
}
