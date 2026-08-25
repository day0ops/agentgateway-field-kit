import { readFile } from 'fs/promises';
import yaml from 'js-yaml';
import { InstallAdapter } from './runbook-adapters/install.js';
import { AddonAdapter } from './runbook-adapters/addon.js';
import { ProviderAdapter } from './runbook-adapters/provider.js';
import { UseCaseAdapter } from './runbook-adapters/usecase.js';
import { FeatureAdapter } from './runbook-adapters/feature.js';
import { UseCaseManager } from './usecase.js';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { Prompts } from './prompts.js';
import { ProfileManager } from './profiles.js';
import { EnvironmentManager } from './environment.js';
import { ProfileSchema } from './profile-schema.js';
import { mergeAddonConfig } from './addons.js';

/**
 * Slugify heading text into a URL anchor.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/ /g, '-');
}

/**
 * Scan markdown for h2/h3/h4 headings and return anchor entries.
 * @param {string} content
 * @returns {Array<{level: number, text: string, anchor: string}>}
 */
export function scanHeadings(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)$/);
    const h3 = line.match(/^### (.+)$/);
    const h4 = line.match(/^#### (.+)$/);
    if (h2) {
      entries.push({ level: 2, text: h2[1], anchor: slugify(h2[1]) });
    } else if (h3) {
      entries.push({ level: 3, text: h3[1], anchor: slugify(h3[1]) });
    } else if (h4) {
      entries.push({ level: 4, text: h4[1], anchor: slugify(h4[1]) });
    }
  }
  return entries;
}

/**
 * RunbookBuilder
 *
 * Assembles a single runbook.md from a RunbookSelection.
 * Adapters (Install, Addon, Provider, UseCase, Feature) each return markdown
 * for their section. Env vars are collected from all adapters and rendered
 * as a deduped table at the top.
 *
 * @typedef {Object} RunbookSelection
 * @property {string} title
 * @property {string[]} addons
 * @property {string[]} providers
 * @property {Array<{type:'usecase'|'feature', name:string}>} labs
 * @property {{name: string, file: string}|null} profile
 * @property {string|null} environment
 */
export class RunbookBuilder {
  constructor(selection) {
    this.selection = selection;
    this.projectRoot = selection.projectRoot ?? process.cwd();
  }

  /**
   * Build the full runbook markdown document.
   * @returns {Promise<string>}
   */
  async build() {
    return this._assembleMarkdown();
  }

  /**
   * Render the runbook as a standalone HTML page.
   * @returns {Promise<string>}
   */
  async buildHtml() {
    const markdown = await this._assembleMarkdown();
    const usecases = await this._resolveHeroUsecases();
    const { HtmlRenderer } = await import('./runbook-html.js');
    return new HtmlRenderer().render(markdown, { ...this.selection, usecases });
  }

  /**
   * Resolve the single use case featured in the HTML hero, if exactly one was
   * selected. Returns [] otherwise, which suppresses the hero.
   * @returns {Promise<Array<object>>}
   */
  async _resolveHeroUsecases() {
    const usecaseLabs = (this.selection.labs || []).filter(l => l.type === 'usecase');
    if (usecaseLabs.length !== 1) return [];
    try {
      const { UseCaseManager } = await import('./usecase.js');
      const meta = await UseCaseManager.get(usecaseLabs[0].name, this.projectRoot);
      return [await UseCaseManager.parse(meta.file)];
    } catch {
      return [];
    }
  }

  /**
   * Assemble the full runbook markdown document.
   * @returns {Promise<string>}
   */
  async _assembleMarkdown() {
    const {
      title = 'Agentgateway Runbook',
      addons = [],
      providers = [],
      labs = [],
      profile = null,
      environment = null,
    } = this.selection;
    const projectRoot = this.projectRoot;

    // Load profile data if a profile was selected
    let profileData = null;
    if (profile) {
      try {
        const rawContent = await readFile(profile.file, 'utf8');
        const raw = yaml.load(rawContent);
        let profileData = ProfileSchema.normalize(raw, profile.file);
        // Use selected environment, or fall back to profile's embedded environment
        const envName = environment || profileData.environment || 'local';
        try {
          const env = await EnvironmentManager.load(envName);
          profileData = EnvironmentManager.resolveAllTemplates(profileData, env);
        } catch {
          // continue without template resolution
        }
      } catch {
        // continue without profile data
      }
    }

    const envVarMap = new Map(); // name → {name, required, description}
    const labSections = [];
    let labNum = 0;

    // ── Lab 0: Installation ─────────────────────────────────────────────────
    InstallAdapter.envVars(profileData).forEach(v => envVarMap.set(v.name, v));
    for (const addonName of addons) {
      (await AddonAdapter.envVarsFor(addonName, null, projectRoot)).forEach(v =>
        envVarMap.set(v.name, v)
      );
    }

    // Collect all env exports for the consolidated section
    const allEnvExports = [];

    // from install
    InstallAdapter.envExports(profileData).forEach(e => allEnvExports.push(e));

    // from addons
    for (const addonName of addons) {
      const profileAddonEntry = profileData?.addons?.find(a => a.name === addonName);
      const profileAddonConfig = profileAddonEntry ? mergeAddonConfig(profileAddonEntry) : null;
      (await AddonAdapter.envExportsFor(addonName, profileAddonConfig, projectRoot)).forEach(e =>
        allEnvExports.push(e)
      );
    }

    // Deduplicate by key (first occurrence wins)
    const seenExportKeys = new Set();
    const dedupedExports = allEnvExports.filter(e => {
      if (seenExportKeys.has(e.key)) return false;
      seenExportKeys.add(e.key);
      return true;
    });

    // Build addon config map for cleanup
    const addonConfigMap = {};
    for (const addonName of addons) {
      const entry = profileData?.addons?.find(a => a.name === addonName);
      addonConfigMap[addonName] = entry ? mergeAddonConfig(entry) : null;
    }

    const installLines = [
      await InstallAdapter.generate({
        addons,
        labNum,
        profileData,
        projectRoot,
        envExports: dedupedExports,
      }),
    ];
    for (const addonName of addons) {
      const profileAddonEntry = profileData?.addons?.find(a => a.name === addonName);
      const profileAddonConfig = profileAddonEntry ? mergeAddonConfig(profileAddonEntry) : null;
      installLines.push('');
      installLines.push(
        await AddonAdapter.generate(addonName, labNum, profileAddonConfig, projectRoot)
      );
    }
    labSections.push(installLines.join('\n'));
    labNum++;

    // ── Lab 1: Providers ────────────────────────────────────────────────────
    if (providers.length > 0) {
      ProviderAdapter.envVarsFor(providers).forEach(v => envVarMap.set(v.name, v));
      labSections.push(await ProviderAdapter.generate(providers, labNum, projectRoot));
      labNum++;
    }

    // ── Labs N: use cases + standalone features ─────────────────────────────
    for (const lab of labs) {
      if (lab.type === 'usecase') {
        labSections.push(
          await UseCaseAdapter.generate({
            name: lab.name,
            labNum,
            deployedProviders: providers,
            projectRoot,
          })
        );
      } else if (lab.type === 'feature') {
        labSections.push(await FeatureAdapter.generate({ name: lab.name, labNum, projectRoot }));
      }
      labNum++;
    }

    // ── Assemble ────────────────────────────────────────────────────────────
    const allEnvVars = [...envVarMap.values()];
    const parts = [
      `# ${title}\n`,
      this._renderPrerequisites(),
      this._renderVersions(profileData),
      this._renderEnvVarsSection(allEnvVars, dedupedExports),
      ...labSections,
      await this._renderCleanup(profileData, addons, addonConfigMap, projectRoot),
    ];

    return parts.join('\n\n---\n\n');
  }

  /**
   * Render a component versions table from InstallAdapter version info.
   * @param {object|null} profileData
   * @returns {string}
   */
  _renderVersions(profileData = null) {
    const { agwVersion, gatewayApiVersion, agwOci } = InstallAdapter.versions(profileData);
    return [
      '## Component Versions',
      '',
      '| Component | Version |',
      '|-----------|---------|',
      `| Enterprise Agentgateway | \`${agwVersion}\` |`,
      `| Gateway API | \`${gatewayApiVersion}\` |`,
      `| Helm chart registry | \`${agwOci}\` |`,
    ].join('\n');
  }

  /**
   * Render env vars credentials table and bash exports block.
   * @param {Array<{name:string, required:boolean|string, description:string}>} vars
   * @param {Array<{key:string, value:string, group:string}>} exports
   * @returns {string}
   */
  _renderEnvVarsSection(vars, exports = []) {
    const groupLabels = {
      credentials: 'Credentials',
      versions: 'Component versions',
      registry: 'Helm registries',
      settings: 'Kubernetes settings',
      endpoints: 'Service endpoints',
    };
    const groupOrder = ['credentials', 'versions', 'registry', 'settings', 'endpoints'];

    // Deduplicate and sort credential vars
    const seen = new Set();
    const dedupedVars = vars.filter(v => {
      if (seen.has(v.name)) return false;
      seen.add(v.name);
      return true;
    });
    dedupedVars.sort((a, b) => {
      const aReq = a.required === true || a.required === 'true';
      const bReq = b.required === true || b.required === 'true';
      if (aReq && !bReq) return -1;
      if (!aReq && bReq) return 1;
      return a.name.localeCompare(b.name);
    });

    // Deduplicate exports
    const seenKeys = new Set();
    const dedupedExports = exports.filter(e => {
      if (seenKeys.has(e.key)) return false;
      seenKeys.add(e.key);
      return true;
    });

    // Build unified row list: credentials first, then exports by group
    const credRows = dedupedVars.map(v => ({
      group: 'credentials',
      variable: v.name,
      required: v.required === true ? '✅ Required' : v.required || 'Optional',
      description: v.description || '',
    }));
    const exportRows = dedupedExports.map(e => ({
      group: e.group || 'settings',
      variable: e.key,
      required: '-',
      description: `\`${e.value}\``,
    }));

    const allRows = [...credRows, ...exportRows].sort((a, b) => {
      const ai = groupOrder.indexOf(a.group);
      const bi = groupOrder.indexOf(b.group);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const lines = ['## Environment Variables', '', 'Set these before running any commands.', ''];

    if (allRows.length > 0) {
      lines.push('| Category | Variable | Required | Description |');
      lines.push('|----------|----------|----------|-------------|');
      let currentGroup = null;
      for (const row of allRows) {
        const categoryCell = currentGroup === row.group ? '' : groupLabels[row.group] || row.group;
        currentGroup = row.group;
        lines.push(
          `| ${categoryCell} | \`${row.variable}\` | ${row.required} | ${row.description} |`
        );
      }
      lines.push('');
    }

    // Collapsible bash exports block for copy-paste convenience
    if (dedupedExports.length > 0) {
      const exportGroupOrder = ['versions', 'registry', 'settings', 'endpoints'];
      const groupComments = {
        versions: '# Component versions',
        registry: '# Helm registries',
        settings: '# Kubernetes settings',
        endpoints: '# Service endpoints',
      };

      const sortedExports = [...dedupedExports].sort((a, b) => {
        const ai = exportGroupOrder.indexOf(a.group || 'settings');
        const bi = exportGroupOrder.indexOf(b.group || 'settings');
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      lines.push('<details>');
      lines.push('<summary>Copy-paste export block</summary>');
      lines.push('');
      lines.push('```bash');
      let currentExportGroup = null;
      for (const e of sortedExports) {
        const group = e.group || 'settings';
        if (group !== currentExportGroup) {
          if (currentExportGroup !== null) lines.push('');
          lines.push(groupComments[group] || `# ${group}`);
          currentExportGroup = group;
        }
        lines.push(`export ${e.key}="${e.value}"`);
      }
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }

    return lines.join('\n');
  }

  _renderPrerequisites() {
    return [
      '## Prerequisites',
      '',
      'Ensure the following tools are installed and on your PATH:',
      '',
      '| Tool | Purpose |',
      '|------|---------|',
      '| `kubectl` | Kubernetes CLI |',
      '| `helm` | Kubernetes package manager |',
      '| `curl` | HTTP testing |',
      '| `jq` | JSON processing |',
      '',
      'A running Kubernetes cluster with the current context pointing to it is assumed.',
    ].join('\n');
  }

  async _renderCleanup(
    profileData = null,
    addons = [],
    addonConfigs = {},
    projectRoot = process.cwd()
  ) {
    const { agwRelease, agwCrdsRelease, gatewayApiChannel } = InstallAdapter.versions(profileData);
    const installFile =
      gatewayApiChannel === 'experimental' ? 'experimental-install.yaml' : 'standard-install.yaml';

    const sections = ['## Cleanup', '', 'To remove all resources created in this runbook:', ''];

    // Addon cleanup in reverse install order
    for (const addonName of [...addons].reverse()) {
      const cfg = addonConfigs[addonName] ?? null;
      const cleanupMd = await AddonAdapter.cleanupFor(addonName, cfg, projectRoot);
      if (cleanupMd) {
        const title = addonName
          .split('-')
          .map(w => w[0].toUpperCase() + w.slice(1))
          .join(' ');
        sections.push(`### Remove ${title}`);
        sections.push('');
        sections.push(cleanupMd);
        sections.push('');
      }
    }

    sections.push('### Remove Agentgateway');
    sections.push('');
    sections.push('```bash');
    sections.push(`helm uninstall ${agwRelease} -n \${AGW_NAMESPACE}`);
    sections.push(`helm uninstall ${agwCrdsRelease} -n \${AGW_NAMESPACE}`);
    sections.push('');
    sections.push('# Remove Gateway API CRDs');
    sections.push(
      `kubectl delete -f https://github.com/kubernetes-sigs/gateway-api/releases/download/\${GATEWAY_API_VERSION}/${installFile}`
    );
    sections.push('');
    sections.push('# Remove namespace');
    sections.push('kubectl delete namespace ${AGW_NAMESPACE} --ignore-not-found');
    sections.push('```');

    return sections.join('\n');
  }
}

const KNOWN_PROVIDERS = [
  { name: 'openai', label: 'OpenAI', description: 'GPT-4o, o1, embeddings' },
  { name: 'bedrock', label: 'AWS Bedrock', description: 'Claude, Titan, Llama via AWS' },
  { name: 'vertex-ai', label: 'Google Vertex AI', description: 'Gemini via Google Cloud' },
  { name: 'anthropic', label: 'Anthropic', description: 'Claude models direct API' },
  { name: 'azure', label: 'Azure OpenAI', description: 'OpenAI models via Azure' },
];

const ADDON_DESCRIPTIONS = {
  telemetry: 'Prometheus · Grafana · Tempo · Loki',
  'cert-manager': 'automated TLS certificate management',
  'solo-ui': 'Solo UI management console',
  keycloak: 'Keycloak identity provider + PostgreSQL',
};

function _choiceName(label, description, width = 24) {
  const indented = '  ' + label;
  return description ? indented.padEnd(width) + description : indented;
}

function _separator(title, description) {
  return new inquirer.Separator(
    chalk.bold.magenta(` ${title}`) + (description ? chalk.dim(`  —  ${description}`) : '')
  );
}

function _gap() {
  return new inquirer.Separator(' ');
}

/**
 * Interactive picker that builds a RunbookSelection from user choices.
 * Uses Prompts.multiSelect (inquirer checkbox) grouped by category.
 */
export class RunbookPicker {
  /**
   * Build flat choice list for the multi-select picker.
   * Choices are grouped by separators: Addons, Providers, Use Cases.
   * @returns {Promise<Array>}
   */
  static async buildChoices(projectRoot = process.cwd()) {
    const choices = [];

    // Addons
    choices.push(_separator('Addons', 'optional infrastructure components to install'));
    for (const addonName of await AddonAdapter.knownAddons(projectRoot)) {
      choices.push({
        name: _choiceName(addonName, ADDON_DESCRIPTIONS[addonName]),
        value: { type: 'addon', name: addonName },
      });
    }

    // Providers
    choices.push(_gap());
    choices.push(_separator('Providers', 'LLM backends to demo'));
    for (const p of KNOWN_PROVIDERS) {
      choices.push({
        name: _choiceName(p.label, p.description),
        value: { type: 'provider', name: p.name },
      });
    }

    // Use cases grouped by category
    const usecases = await UseCaseManager.list(projectRoot);
    const byCategory = new Map();
    for (const uc of usecases) {
      const cat = uc.category || 'general';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(uc);
    }

    for (const [cat, items] of [...byCategory.entries()].sort()) {
      choices.push(_gap());
      choices.push(_separator(`Use Cases: ${cat}`, 'feature demonstration labs'));
      for (const uc of items) {
        choices.push({
          name: _choiceName(uc.displayName || uc.name, null),
          value: { type: 'usecase', name: uc.name },
        });
      }
    }

    return choices;
  }

  /**
   * Run interactive prompts and return a RunbookSelection.
   * @returns {Promise<import('./runbook.js').RunbookSelection>}
   */
  static async prompt() {
    const projectRoot = process.cwd();
    const title = await Prompts.input('Runbook title:', 'Agentgateway Runbook');

    // Profile selection
    let profile = null;
    let environment = null;
    const profiles = await ProfileManager.list(projectRoot);
    if (profiles.length > 0) {
      const profileChoices = [
        { name: 'None (use defaults)', value: null },
        ...profiles.map(p => ({
          name: ProfileManager.formatChoiceLabel(p.name, p.description),
          value: { name: p.name, file: p.file },
        })),
      ];
      profile = await Prompts.select('Select an installation profile:', profileChoices, null);
    }

    // Environment selection
    if (profile) {
      const environments = await EnvironmentManager.list(projectRoot);
      if (environments.length === 1) {
        // Only one environment — auto-select without prompting
        environment = environments[0].name;
      } else if (environments.length > 1) {
        const envChoices = environments.map(e => ({
          name: e.description ? `${e.name} — ${e.description}` : e.name,
          value: e.name,
        }));
        environment = await Prompts.select('Select target environment:', envChoices, 'local');
      }
    }

    const choices = await this.buildChoices(projectRoot);
    const selected = await Prompts.multiSelect('Select labs to include:', choices);

    const addons = selected.filter(s => s.type === 'addon').map(s => s.name);
    const providers = selected.filter(s => s.type === 'provider').map(s => s.name);
    const labs = selected
      .filter(s => s.type === 'usecase' || s.type === 'feature')
      .map(s => ({ type: s.type, name: s.name }));

    return { title, addons, providers, labs, profile, environment, projectRoot };
  }
}
