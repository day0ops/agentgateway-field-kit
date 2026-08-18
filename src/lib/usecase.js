import { readdir, readFile, writeFile, access } from 'fs/promises';
import { existsSync, constants as fsConstants } from 'node:fs';
import { join, basename, relative, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import chalk from 'chalk';
import logSymbols from 'log-symbols';
import { Prompts } from './prompts.js';
import { Logger, SpinnerLogger, KubernetesHelper, formatDescription } from './common.js';
import { FeatureManager, PolicyRegistry } from '../../features/index.js';
import { EnvironmentManager } from './environment.js';
import {
  showStepHeader,
  showUseCaseOverview,
  showWaitPrompt,
  generateMermaidForUseCase,
} from './diagrams.js';
import { UseCaseTestRunner } from './usecase-tests.js';
import {
  EDITIONS,
  DEFAULT_EDITION,
  resolveEdition,
  EDITION_GATEWAY_NAME,
  EDITION_BASE_NAME,
} from './editions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const TRACKING_CONFIGMAP = 'agentgateway-current-usecase';
const TRACKING_NAMESPACE = process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system';

/**
 * Sort tree nodes in-place: directories first (alphabetically), then leaves (alphabetically).
 * @param {Array} nodes
 */
function _sortTreeLevel(nodes) {
  nodes.sort((a, b) => {
    const aIsDir = !!a.children;
    const bIsDir = !!b.children;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    const aKey = a.label || a.name || '';
    const bKey = b.label || b.name || '';
    return aKey.localeCompare(bKey);
  });
  for (const node of nodes) {
    if (node.children) _sortTreeLevel(node.children);
  }
}

/**
 * Wait for user to press Space or Enter (for stepped demo flow).
 * Skips waiting if stdin is not a TTY (e.g. in CI).
 * @returns {Promise<void>}
 */
function waitForKey() {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolve();
      return;
    }
    const onData = key => {
      const k = Buffer.isBuffer(key) ? key.toString() : key;
      if (k === '\u0003') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.exit(0);
      }
      if (k === ' ' || k === '\r' || k === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        resolve();
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

/**
 * Use case management utilities
 * Handles agentgateway use case deployments with automatic cleanup of previous use cases
 */
export class UseCaseManager {
  static USECASES_DIR = join(PROJECT_ROOT, 'config/usecases');

  /**
   * Recursively find all YAML files in a directory
   * @param {string} dir - Directory to search
   * @param {string} baseDir - Base directory for relative paths
   * @returns {Promise<Array<{file: string, relativePath: string}>>}
   */
  static async findYamlFiles(dir, baseDir = this.USECASES_DIR) {
    const files = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        const subFiles = await this.findYamlFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
        files.push({
          file: fullPath,
          relativePath: relativePath.replace(/\\/g, '/'),
        });
      }
    }

    return files;
  }

  /**
   * Get all available use cases (recursively searches subdirectories)
   * A recognized edition literal ('enterprise'|'opensource') as the first path segment is
   * stripped before computing category, so category is always the segment after any edition
   * prefix. Use cases with no recognized edition prefix default to 'enterprise'.
   * @param {string} [root] - Optional project root directory. Defaults to this project's root.
   * @returns {Promise<Array<{name: string, file: string, displayName: string, category?: string, edition: string, deprecated: {reason: string, replacedBy: string}|null}>>}
   */
  static async list(root) {
    try {
      const dir = root ? join(root, 'config', 'usecases') : this.USECASES_DIR;
      if (!existsSync(dir)) {
        return [];
      }
      const yamlFiles = await this.findYamlFiles(dir, dir);
      return await Promise.all(
        yamlFiles.map(async ({ file, relativePath }) => {
          let pathParts = relativePath.split('/');
          let edition = DEFAULT_EDITION;
          if (EDITIONS.includes(pathParts[0]) && pathParts.length > 1) {
            edition = pathParts[0];
            pathParts = pathParts.slice(1);
          }
          const category = pathParts.length > 1 ? pathParts[0] : undefined;
          const name = basename(file, '.yaml');
          const displayName = category
            ? `${category}/${name}`.replace(/-/g, ' ')
            : name.replace(/-/g, ' ');
          const relPath = relativePath.replace(/\.yaml$/, '');
          const usecase = await this.parse(file);
          const deprecated = usecase?.spec?.deprecated ?? null;
          return { name, file, displayName, category, edition, relativePath: relPath, deprecated };
        })
      );
    } catch (error) {
      throw new Error(`Failed to list use cases: ${error.message}`);
    }
  }

  /**
   * Parse a use case reference into an optional leading edition segment and the rest.
   * A recognized edition literal is only consumed when there's at least one segment left
   * after it (so a bare 'opensource' is treated as a literal name, not an empty edition filter).
   * @param {string} name
   * @returns {{ edition: string|null, rest: string[] }}
   */
  static _parseUseCaseRef(name) {
    const parts = name.split('/');
    if (EDITIONS.includes(parts[0]) && parts.length > 1) {
      return { edition: parts[0], rest: parts.slice(1) };
    }
    return { edition: null, rest: parts };
  }

  /**
   * Get a specific use case by name. Supports:
   *   - bare name: "apikey-auth"
   *   - category/name: "security/apikey-auth"
   *   - edition/category/name: "opensource/mcp/mcp-auth"
   *   - edition/name: "opensource/static-mcp-server"
   * When unprefixed and multiple use cases share the same category/name (or bare name) across
   * editions, the enterprise match wins if there's exactly one - preserving every existing
   * unprefixed reference's resolution unmodified.
   * @param {string} name - Use case reference (see formats above)
   * @param {string} [root] - Optional project root directory. Defaults to this project's root.
   * @returns {Promise<{name: string, file: string, displayName: string, category?: string, edition: string}>}
   */
  static async get(name, root) {
    const usecases = await this.list(root);
    const { edition, rest } = this._parseUseCaseRef(name);

    let candidates;
    if (rest.length >= 2) {
      const [category, usecaseName] = rest;
      candidates = usecases.filter(u => u.category === category && u.name === usecaseName);
    } else {
      candidates = usecases.filter(u => u.name === rest[0]);
    }

    if (edition) {
      candidates = candidates.filter(u => u.edition === edition);
    }

    let usecase;
    if (candidates.length === 1) {
      usecase = candidates[0];
    } else if (candidates.length > 1) {
      if (!edition) {
        const enterpriseMatches = candidates.filter(u => u.edition === 'enterprise');
        if (enterpriseMatches.length === 1) {
          usecase = enterpriseMatches[0];
        }
      }
      if (!usecase) {
        throw new Error(
          `Ambiguous use case name '${name}'. Use edition/category/name format. ` +
            `Found in: ${candidates.map(m => `${m.edition}/${m.category || 'root'}`).join(', ')}`
        );
      }
    }

    if (!usecase) {
      throw new Error(`Use case '${name}' not found`);
    }
    return usecase;
  }

  /**
   * Prompt user to select a use case
   * @returns {Promise<{name: string, file: string}>} Selected use case
   */
  static async select() {
    try {
      const usecases = await this.list();

      if (usecases.length === 0) {
        throw new Error('No use cases found in config/usecases/');
      }

      const tree = UseCaseManager._buildTree(usecases);
      const selectedPath = await Prompts.selectTree('Select use case to deploy:', tree);
      const usecase = usecases.find(u => u.relativePath === selectedPath);

      return {
        name: usecase.name,
        file: usecase.file,
      };
    } catch (error) {
      throw new Error(`Failed to select use case: ${error.message}`);
    }
  }

  /**
   * Build a recursive directory tree from a list of use cases.
   * Each node is either a directory ({ label, children[] }) or a leaf ({ name, value }).
   * Leaf value is the usecase's relativePath for unambiguous lookup.
   * @param {Array<{name: string, relativePath: string}>} usecases
   * @returns {Array} Root-level tree nodes
   */
  static _buildTree(usecases) {
    const root = [];

    for (const uc of usecases) {
      const parts = uc.relativePath.split('/');
      let current = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        let dirNode = current.find(n => n.children && n.label === dirName);
        if (!dirNode) {
          dirNode = { label: dirName, children: [] };
          current.push(dirNode);
        }
        current = dirNode.children;
      }

      current.push({
        name: parts[parts.length - 1].replace(/-/g, ' '),
        value: uc.relativePath,
      });
    }

    _sortTreeLevel(root);
    return root;
  }

  /**
   * Parse use case YAML file
   * @param {string} filePath - Path to the use case YAML file
   * @returns {Promise<Object>} Parsed use case definition
   */
  static async parse(filePath) {
    try {
      const content = await readFile(filePath, 'utf8');
      const usecase = yaml.load(content);

      if (!usecase || !usecase.spec) {
        throw new Error('Invalid use case file: missing spec');
      }

      return usecase;
    } catch (error) {
      throw new Error(`Failed to parse use case file: ${error.message}`);
    }
  }

  /**
   * Get the currently deployed use case
   * Assumes the caller has already verified cluster accessibility.
   * @returns {Promise<string|null>} Current use case name or null
   */
  static async getCurrentUseCase() {
    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'configmap',
          TRACKING_CONFIGMAP,
          '-n',
          TRACKING_NAMESPACE,
          '-o',
          'jsonpath={.data.usecase}',
        ],
        { ignoreError: true }
      );

      const raw = result.stdout.trim() || null;
      if (!raw) return null;
      return raw.startsWith('/') ? raw : join(this.USECASES_DIR, raw);
    } catch {
      return null;
    }
  }

  /**
   * Set the currently deployed use case
   * @param {string} name - Use case name
   */
  static async setCurrentUseCase(name) {
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: TRACKING_CONFIGMAP,
        namespace: TRACKING_NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/component': 'usecase-tracker',
        },
      },
      data: {
        usecase: name,
      },
    };

    const yamlContent = yaml.dump(configMap);
    await KubernetesHelper.applyYaml(yamlContent);
  }

  /**
   * Clear the current use case tracking
   */
  static async clearCurrentUseCase() {
    try {
      await KubernetesHelper.kubectl([
        'delete',
        'configmap',
        TRACKING_CONFIGMAP,
        '-n',
        TRACKING_NAMESPACE,
        '--ignore-not-found=true',
      ]);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get ordered steps from use case spec.
   * Uses spec.steps if present; otherwise infers steps from spec.features
   * @param {Object} spec - Use case spec
   * @returns {Array<{ title: string, description?: string, features: Array<{name: string, config?: object}> }>}
   */
  static getSteps(spec) {
    if (spec.steps && Array.isArray(spec.steps) && spec.steps.length > 0) {
      return spec.steps.map(s => ({
        title: s.title || 'Step',
        description: s.description,
        features: s.features || [],
      }));
    }
    const features = spec.features || [];
    if (features.length === 0) return [];

    const gatewayFeatures = features.filter(f => f.name === 'gateway');
    const rest = features.filter(f => f.name !== 'gateway');
    const providerFeatures = rest.filter(f => f.name === 'providers');
    const policyFeatures = rest.filter(f => f.name !== 'providers');

    const steps = [];
    if (gatewayFeatures.length > 0) {
      steps.push({
        title: 'Gateway',
        description: 'Configure the Gateway (HTTPRoutes will reference it via parentRefs).',
        features: gatewayFeatures,
      });
    }
    if (providerFeatures.length > 0) {
      steps.push({
        title: 'Add provider',
        description: 'Configure the LLM provider backend and route.',
        features: providerFeatures,
      });
    }
    if (policyFeatures.length > 0) {
      steps.push({
        title: 'Add policy',
        description: 'Apply policies (guardrails, enrichment, etc.) to the route.',
        features: policyFeatures,
      });
    }
    if (steps.length === 0) {
      steps.push({ title: 'Deploy', features });
    }
    return steps;
  }

  /**
   * Generate Mermaid diagram for all use case YAML files and set spec.diagram.
   * @returns {Promise<{ updated: string[], skipped: string[], errors: Array<{ file: string, error: string }> }>}
   */
  static async generateDiagramsForAll() {
    const yamlFiles = await this.findYamlFiles(this.USECASES_DIR);
    const updated = [];
    const skipped = [];
    const errors = [];

    for (const { file } of yamlFiles) {
      try {
        const content = await readFile(file, 'utf8');
        const usecase = yaml.load(content);
        if (!usecase?.spec) {
          skipped.push(file);
          continue;
        }
        const { metadata, spec } = usecase;
        const steps = this.getSteps(spec);
        if (steps.length === 0) {
          skipped.push(file);
          continue;
        }
        const mermaid = generateMermaidForUseCase(metadata, spec, steps);
        if (!mermaid) {
          skipped.push(file);
          continue;
        }
        spec.diagram = mermaid;
        const out = yaml.dump(usecase, { lineWidth: -1, indent: 2 });
        await writeFile(file, out, 'utf8');
        updated.push(file);
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }

    return { updated, skipped, errors };
  }

  /**
   * Deploy a use case
   * @param {string} name - Use case name or file path
   * @param {Object} [options] - Deploy options
   * @param {boolean} [options.interactive=true] - When false, skip step-by-step prompts and run all steps automatically
   * @param {boolean} [options.diagrams=true] - When false, hide ASCII flow diagrams
   * @param {boolean} [options.test=true] - When false, skip running use case tests after deploy
   * @returns {Promise<void>}
   */
  static async deploy(name, options = {}) {
    const { interactive = true, diagrams: diagramsOpt = true, test = true, environment } = options;
    const diagrams = diagramsOpt && process.env.HIDE_DIAGRAMS !== 'true';
    const spinner = new SpinnerLogger();

    try {
      let filePath;
      if (name.endsWith('.yaml')) {
        filePath = name;
      } else {
        const usecase = await this.get(name);
        filePath = usecase.file;
      }

      let usecase = await this.parse(filePath);

      const envName = environment || (await EnvironmentManager.resolveActive());
      const env = await EnvironmentManager.load(envName);
      usecase = EnvironmentManager.resolveAllTemplates(usecase, env);
      Logger.info(`Using environment: ${envName}`);

      const { metadata, spec } = usecase;

      if (spec.deprecated) {
        Logger.warn(
          `Use case '${metadata.name}' is deprecated: ${spec.deprecated.reason} Use '${spec.deprecated.replacedBy}' instead.`
        );
      }

      const currentUseCase = await this.getCurrentUseCase();

      if (currentUseCase && currentUseCase !== filePath) {
        Logger.warn('Found existing use case deployed');
        Logger.info(`Cleaning up previous use case before deploying '${metadata.name}'...`);

        try {
          await this.cleanup(currentUseCase);
          Logger.success('Previous use case cleaned up');
        } catch (error) {
          Logger.warn(`Failed to clean up previous use case: ${error.message}`);
          Logger.info('Continuing with deployment...');
        }
      }

      Logger.info(`Deploying use case: ${metadata.name}`);

      const { namespace, providers = [] } = spec;

      if (namespace) {
        Logger.info(`Using namespace: ${namespace}`);
        FeatureManager.setDefaultNamespace(namespace);
      }

      if (providers.length > 0) {
        Logger.info(`Providers: ${providers.join(', ')}`);
      }

      const steps = this.getSteps(spec);
      const allFeatures = steps.flatMap(s => s.features);

      if (allFeatures.length === 0) {
        Logger.warn('No features configured in use case');
        return;
      }

      const edition = resolveEdition(spec.edition);
      this.validateFeatureEditions(metadata.name, edition, allFeatures);

      const specForPreprocess = { ...spec, features: allFeatures };
      this.preprocessFeatures(specForPreprocess);

      FeatureManager.setGatewayRef({
        name: EDITION_GATEWAY_NAME[edition],
        namespace: FeatureManager.getDefaultNamespace(),
      });

      // Enable policy registry for staged application
      PolicyRegistry.enable();

      const useSteppedFlow = interactive && steps.length > 0 && process.stdin.isTTY;

      if (useSteppedFlow && diagrams) {
        let mermaidText = spec.diagram || null;
        if (!mermaidText && filePath && filePath.endsWith('.yaml')) {
          const mdPath = filePath.replace(/\.yaml$/i, '.md');
          try {
            const mdContent = await readFile(mdPath, 'utf8');
            const match = mdContent.match(/```mermaid\s*\n([\s\S]*?)```/);
            if (match) mermaidText = match[1].trim();
          } catch {
            // no companion .md or no mermaid block
          }
        }
        if (!mermaidText && steps.length > 0) {
          mermaidText = generateMermaidForUseCase(metadata, spec, steps);
        }
        await showUseCaseOverview(metadata, spec, steps, mermaidText);
        showWaitPrompt();
        await waitForKey();
      }

      if (useSteppedFlow && steps.length > 1 && !diagrams) {
        showWaitPrompt();
        await waitForKey();
      }

      // Show description for non-stepped flows (stepped flows show it in showUseCaseOverview)
      if (!useSteppedFlow && metadata.description) {
        console.log(chalk.dim('─'.repeat(Math.min(process.stdout.columns || 80, 80))));
        if (spec.deprecated) {
          console.log(
            `${logSymbols.warning} ` +
              chalk.bgYellow.black.bold(' DEPRECATED ') +
              ' ' +
              chalk.yellow(`${spec.deprecated.reason} Use '${spec.deprecated.replacedBy}' instead.`)
          );
        }
        console.log(formatDescription(metadata.description));
        console.log(chalk.dim('─'.repeat(Math.min(process.stdout.columns || 80, 80))));
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepIndex = i + 1;
        const totalSteps = steps.length;

        if (useSteppedFlow) {
          showStepHeader(stepIndex, totalSteps, step.title, step.description);
          Logger.info(`Applying: ${step.features.map(f => f.name).join(', ')}`);
          showWaitPrompt();
          await waitForKey();
        } else if (steps.length > 1) {
          Logger.info(
            `Step ${stepIndex}/${totalSteps}: ${step.title} — ${step.features.map(f => f.name).join(', ')}`
          );
        }

        for (const feature of step.features) {
          const { name: featureName, config = {} } = feature;
          await FeatureManager.deploy(featureName, config, { edition });
        }
      }

      // Commit all merged policies
      const mergedCount = PolicyRegistry.getMergedPolicyCount();
      if (mergedCount > 0) {
        Logger.info(`Applying ${mergedCount} merged EnterpriseAgentgatewayPolicy resource(s)...`);
        await PolicyRegistry.commit({ spinner });
      }
      PolicyRegistry.disable();

      await this.setCurrentUseCase(relative(this.USECASES_DIR, filePath));

      Logger.success(`Use case '${metadata.name}' deployed successfully`);

      if (test && !process.env.DISABLE_TEST && spec.tests && spec.tests.length > 0) {
        await this.test(filePath);
      }
    } catch (error) {
      spinner.fail(`Failed to deploy use case: ${error.message}`);
      throw error;
    } finally {
      PolicyRegistry.clear();
      PolicyRegistry.disable();
    }
  }

  /**
   * Dry run: generate and print YAML for a use case without applying.
   * @param {string} name - Use case name or file path
   * @returns {Promise<void>}
   */
  static async dryRun(name, options = {}) {
    const { environment, output: outputFile } = options;
    let resolvedOutputPath;
    try {
      if (outputFile) {
        resolvedOutputPath = resolve(outputFile);
        const outDir = dirname(resolvedOutputPath);
        if (!existsSync(outDir)) {
          throw new Error(`Output directory does not exist: ${outDir}`);
        }
        try {
          await access(outDir, fsConstants.W_OK);
        } catch {
          throw new Error(`Output directory is not writable: ${outDir}`);
        }
      }

      let filePath;
      if (name.endsWith('.yaml')) {
        filePath = name;
      } else {
        const usecase = await this.get(name);
        filePath = usecase.file;
      }

      let usecase = await this.parse(filePath);

      const envName = environment || (await EnvironmentManager.resolveActive());
      const env = await EnvironmentManager.load(envName);
      usecase = EnvironmentManager.resolveAllTemplates(usecase, env);

      const { metadata, spec } = usecase;

      if (spec.deprecated) {
        Logger.warn(
          `Use case '${metadata.name}' is deprecated: ${spec.deprecated.reason} Use '${spec.deprecated.replacedBy}' instead.`
        );
      }

      const { namespace } = spec;
      if (namespace) {
        FeatureManager.setDefaultNamespace(namespace);
      }

      const steps = this.getSteps(spec);
      const allFeatures = steps.flatMap(s => s.features);

      if (allFeatures.length === 0) {
        Logger.warn('No features configured in use case');
        return;
      }

      const edition = resolveEdition(spec.edition);
      this.validateFeatureEditions(metadata.name, edition, allFeatures);

      const specForPreprocess = { ...spec, features: allFeatures };
      this.preprocessFeatures(specForPreprocess);

      FeatureManager.setGatewayRef({
        name: EDITION_GATEWAY_NAME[edition],
        namespace: FeatureManager.getDefaultNamespace(),
      });

      // Enable policy registry for staged application
      PolicyRegistry.enable();

      const hasGatewayFeature = allFeatures.some(f => f.name === 'gateway');
      const collected = [];

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        for (const feature of step.features) {
          const { name: featureName, config = {} } = feature;
          const yamlDocs = await FeatureManager.deploy(featureName, config, {
            dryRun: true,
            edition,
          });
          if (yamlDocs && yamlDocs.length > 0) {
            collected.push({ featureName, yamlDocs });
          }
        }
      }

      // Collect merged policies
      const mergedPolicies = await PolicyRegistry.commit({ dryRun: true });
      PolicyRegistry.disable();

      const gatewayRef = FeatureManager.getGatewayRef();
      const lines = [];
      const sep = '# ' + '='.repeat(76);
      lines.push(sep);
      lines.push(`# Generated YAML for use case: ${metadata.name}`);
      if (metadata.description) {
        lines.push('#');
        for (const line of metadata.description.split('\n')) {
          const trimmed = line.trim();
          lines.push(trimmed ? `# ${trimmed}` : '#');
        }
      }
      lines.push(sep);
      lines.push(`# Environment: ${envName}`);
      lines.push('# Gateway referenced by HTTPRoute parentRefs:');
      lines.push(`#   name: ${gatewayRef.name}`);
      lines.push(`#   namespace: ${gatewayRef.namespace}`);
      lines.push(sep);
      lines.push('# Copy the YAML below to apply manually or to another medium.');
      lines.push(sep);
      lines.push('');

      if (!hasGatewayFeature) {
        const defaultGatewayPath = join(PROJECT_ROOT, 'config', 'gateway', 'default-gateway.yaml');
        try {
          let defaultGatewayYaml = await readFile(defaultGatewayPath, 'utf8');
          const defaultGateway = yaml.load(defaultGatewayYaml);
          defaultGateway.metadata.namespace = gatewayRef.namespace;
          defaultGateway.metadata.name = gatewayRef.name;
          defaultGateway.spec.gatewayClassName = EDITION_BASE_NAME[edition];
          defaultGatewayYaml = yaml.dump(defaultGateway, { lineWidth: -1, indent: 2 });
          lines.push('# --- Default Gateway (referenced by HTTPRoutes below) ---');
          lines.push('');
          lines.push('---');
          lines.push(defaultGatewayYaml.trim());
          lines.push('');
        } catch {
          lines.push(`# (Default Gateway YAML not found: ${defaultGatewayPath})`);
          lines.push('');
        }
      }

      for (const { featureName, yamlDocs } of collected) {
        lines.push(`# --- Feature: ${featureName} ---`);
        lines.push('');
        for (const doc of yamlDocs) {
          lines.push('---');
          lines.push(doc.trim());
          lines.push('');
        }
      }

      // Add merged policies section
      if (mergedPolicies.length > 0) {
        lines.push('# --- Merged EnterpriseAgentgatewayPolicy Resources ---');
        lines.push('# The following policies were merged from multiple features:');
        lines.push('');
        for (const doc of mergedPolicies) {
          lines.push('---');
          lines.push(doc.trim());
          lines.push('');
        }
      }

      const output = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();

      if (resolvedOutputPath) {
        try {
          await writeFile(resolvedOutputPath, output + '\n');
        } catch (writeError) {
          throw new Error(
            `Failed to write output file '${resolvedOutputPath}': ${writeError.message}`
          );
        }
        Logger.success(`Generated YAML written to ${resolvedOutputPath}`);
      } else {
        console.log(output);
      }
    } catch (error) {
      Logger.error(`Dry run failed: ${error.message}`);
      throw error;
    } finally {
      PolicyRegistry.clear();
      PolicyRegistry.disable();
    }
  }

  /**
   * Verify every feature referenced by a use case supports the use case's resolved edition.
   * Fails fast, before any Kubernetes calls, rather than letting a mismatched feature fail
   * later with a confusing raw k8s error (e.g. an unknown CRD kind).
   * @param {string} usecaseName - Use case metadata.name, for the error message
   * @param {string} edition - Resolved edition ('enterprise'|'opensource')
   * @param {Array<{name: string}>} features
   */
  static validateFeatureEditions(usecaseName, edition, features) {
    for (const { name: featureName } of features) {
      const supported = FeatureManager.getSupportedEditions(featureName);
      if (!supported.includes(edition)) {
        throw new Error(
          `Use case '${usecaseName}' declares edition '${edition}' but feature '${featureName}' only supports: ${supported.join(', ')}.`
        );
      }
    }
  }

  /**
   * Pre-process features to inject dynamic configuration
   * @param {Object} spec - Use case spec
   */
  static preprocessFeatures(spec) {
    const providersFeature = spec.features.find(f => f.name === 'providers');
    if (!providersFeature) {
      return;
    }

    const providers = providersFeature.config?.providers || [];
    if (providers.length === 0) {
      return;
    }

    const targetRefs = providers.map(provider => {
      const providerName = typeof provider === 'string' ? provider : provider.name;
      return {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: providerName,
      };
    });

    const policyFeatures = ['prompt-guards', 'prompt-enrichment', 'guardrail-webhook'];
    for (const feature of spec.features) {
      if (policyFeatures.includes(feature.name) && !feature.config?.targetRefs) {
        feature.config = feature.config || {};
        feature.config.targetRefs = targetRefs;
        Logger.debug(
          `Auto-injected targetRefs for ${feature.name}: ${targetRefs.map(t => t.name).join(', ')}`
        );
      }
    }

    const providerRouteNames = providers.map(p => (typeof p === 'string' ? p : p.name));
    const quotaFeatures = ['quota-budget', 'quota-ratelimit'];
    for (const feature of spec.features) {
      if (quotaFeatures.includes(feature.name) && !feature.config?.providerRoutes) {
        feature.config = feature.config || {};
        feature.config.providerRoutes = providerRouteNames;
        Logger.debug(
          `Auto-injected providerRoutes for ${feature.name}: ${providerRouteNames.join(', ')}`
        );
      }
    }
  }

  /**
   * Clean up a use case
   * @param {string} name - Use case name or file path
   * @returns {Promise<void>}
   */
  static async cleanup(name) {
    const spinner = new SpinnerLogger();

    try {
      let filePath;
      if (name.endsWith('.yaml')) {
        filePath = name.startsWith('/') ? name : join(this.USECASES_DIR, name);
      } else {
        const usecase = await this.get(name);
        filePath = usecase.file;
      }

      if (!existsSync(filePath)) {
        Logger.warn(`Use case file not found (may have been moved/renamed): ${filePath}`);
        Logger.info('Clearing stale use case tracking...');
        await this.clearCurrentUseCase();
        return;
      }

      let usecase = await this.parse(filePath);

      const envName = await EnvironmentManager.resolveActive();
      const env = await EnvironmentManager.load(envName);
      usecase = EnvironmentManager.resolveAllTemplates(usecase, env);

      const { metadata, spec } = usecase;

      const { namespace } = spec;
      const steps = this.getSteps(spec);
      const features = steps.flatMap(s => s.features);

      if (namespace) {
        FeatureManager.setDefaultNamespace(namespace);
      }

      // Resolve the same Gateway ref deploy()/dryRun() would have used, so features whose
      // cleanup() targets a specific live Gateway (e.g. model-costs) patch the right one -
      // even though cleanup runs in a fresh process where FeatureManager.gatewayRef starts null.
      const edition = resolveEdition(spec.edition);
      FeatureManager.setGatewayRef({
        name: EDITION_GATEWAY_NAME[edition],
        namespace: FeatureManager.getDefaultNamespace(),
      });
      const gatewayFeatureConfig = features.find(f => f.name === 'gateway')?.config;
      if (gatewayFeatureConfig) {
        FeatureManager.setGatewayRef({
          name: gatewayFeatureConfig.name,
          namespace: gatewayFeatureConfig.namespace,
        });
      }

      if (features.length === 0) {
        Logger.info(`Cleaning up use case '${metadata.name}' (no features)`);
        return;
      }

      const featureWord = features.length === 1 ? 'feature' : 'features';
      Logger.info(`Cleaning up use case '${metadata.name}' (${features.length} ${featureWord})`);

      for (const feature of features.reverse()) {
        const { name: featureName, config = {} } = feature;

        try {
          await FeatureManager.cleanup(featureName, config, { edition });
        } catch (error) {
          Logger.warn(`Failed to clean up feature '${featureName}': ${error.message}`);
        }
      }

      // Clean up any merged policies created by this use case
      try {
        const result = await KubernetesHelper.kubectl(
          [
            'get',
            'enterpriseagentgatewaypolicy',
            '-n',
            FeatureManager.getDefaultNamespace(),
            '-l',
            'agentgateway.dev/merged-policy=true',
            '-o',
            'jsonpath={.items[*].metadata.name}',
          ],
          { ignoreError: true }
        );

        const policyNames = result.stdout.trim().split(/\s+/).filter(Boolean);
        for (const policyName of policyNames) {
          await KubernetesHelper.kubectl([
            'delete',
            'enterpriseagentgatewaypolicy',
            policyName,
            '-n',
            FeatureManager.getDefaultNamespace(),
            '--ignore-not-found=true',
          ]);
        }
      } catch {
        // Ignore cleanup errors for merged policies
      }

      const currentUseCase = await this.getCurrentUseCase();
      if (currentUseCase === filePath) {
        await this.clearCurrentUseCase();
      }

      Logger.success(`Use case '${metadata.name}' cleaned up successfully`);
    } catch (error) {
      spinner.fail(`Failed to clean up use case: ${error.message}`);
      throw error;
    }
  }

  /**
   * Test a use case
   * @param {string} name - Use case name or file path
   * @returns {Promise<void>}
   */
  static async test(name, options = {}) {
    let filePath;
    if (name.endsWith('.yaml')) {
      filePath = name;
    } else {
      const usecase = await this.get(name);
      filePath = usecase.file;
    }

    let usecase = await this.parse(filePath);
    const envName = options.environment || (await EnvironmentManager.resolveActive());
    const env = await EnvironmentManager.load(envName);
    usecase = EnvironmentManager.resolveAllTemplates(usecase, env);
    const { spec } = usecase;

    // Determine if cleanup should run (CLI flag or spec-level setting)
    const shouldCleanup = options.cleanup || spec.cleanup === true;

    try {
      await UseCaseTestRunner.runTests(usecase);
    } finally {
      // Run cleanup after tests if enabled via CLI flag or spec.cleanup
      if (shouldCleanup) {
        Logger.info('Running post-test cleanup...');
        try {
          await this.cleanup(filePath);
          Logger.success('Post-test cleanup completed');
        } catch (cleanupError) {
          Logger.warn(`Post-test cleanup failed: ${cleanupError.message}`);
        }
      }
    }
  }
}
