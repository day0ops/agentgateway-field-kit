// src/lib/runbook-adapters/usecase.js
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { UseCaseManager } from '../usecase.js';
import { EnvironmentManager } from '../environment.js';

export const UseCaseAdapter = {
  /**
   * Generate a lab section from a use case YAML.
   * @param {{ name: string, labNum: number, deployedProviders: string[], projectRoot?: string, environment?: string|null }} opts
   * @returns {Promise<string>}
   */
  async generate({
    name,
    labNum,
    deployedProviders = [],
    projectRoot = process.cwd(),
    environment = null,
  }) {
    const ucMeta = await UseCaseManager.get(name, projectRoot);
    let ucData = await UseCaseManager.parse(ucMeta.file);
    // Resolve {{env...}} templates in feature configs so the embedded YAML matches
    // what the deploy path produces, instead of literal placeholders.
    try {
      const env = await EnvironmentManager.load(environment || 'local');
      ucData = EnvironmentManager.resolveAllTemplates(ucData, env);
    } catch {
      // continue without template resolution
    }
    const { metadata, spec } = ucData;

    const steps = UseCaseManager.getSteps(spec);
    // Mirror the real deploy path (usecase.js deploy()) so auto-injected
    // targetRefs (policyFeatures) land in the rendered YAML, not stale placeholders.
    const allFeatures = steps.flatMap(s => s.features);
    UseCaseManager.preprocessFeatures({ ...spec, features: allFeatures });
    const lines = [];

    // Lab heading
    const labTitle = _formatTitle(metadata.name || name);
    lines.push(`## Lab ${labNum}: ${labTitle}`);
    lines.push('');

    if (deployedProviders.length > 0) {
      lines.push('> **Prerequisite:** Providers from Lab 1 are assumed to be deployed.');
      lines.push('');
    }

    // Description
    if (metadata.description) {
      lines.push(metadata.description.trim());
      lines.push('');
    }

    // Sequence diagram
    if (spec.diagram) {
      lines.push('### Sequence Diagram');
      lines.push('');
      lines.push('```mermaid');
      lines.push(spec.diagram.trim());
      lines.push('```');
      lines.push('');
    }

    // Steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      lines.push(`### Step ${i + 1}: ${step.title}`);
      lines.push('');

      if (step.description) {
        lines.push(step.description.trim());
        lines.push('');
      }

      for (const featureRef of step.features || []) {
        const yamlDocs = await _getFeatureYaml(
          featureRef.name,
          featureRef.config || {},
          projectRoot
        );
        for (const doc of yamlDocs) {
          lines.push('```yaml');
          lines.push(doc.trim());
          lines.push('```');
          lines.push('');
        }
      }
    }

    // Test It — from a companion .md "## Running" section, falling back to
    // rendering spec.tests directly for the usecases with no companion doc.
    const testSection = (await _extractTestSection(ucMeta.file)) || _renderTestsSection(spec.tests);
    if (testSection) {
      lines.push('### Test It');
      lines.push('');
      lines.push(testSection.trim());
      lines.push('');
    }

    return lines.join('\n');
  },
};

/**
 * Human-readable title for a use case: first line of the description (sans
 * trailing period), falling back to the formatted metadata name.
 * @param {{ metadata?: { name?: string, description?: string } }} usecase
 * @returns {string}
 */
export function usecaseTitle(usecase) {
  return usecase.metadata?.description
    ? usecase.metadata.description.split('\n')[0].trim().replace(/\.$/, '')
    : _formatTitle(usecase.metadata?.name || '');
}

async function _getFeatureYaml(featureName, config, projectRoot) {
  // Check for runbook.md sidecar
  const sidecarPath = join(projectRoot, 'features', featureName, 'runbook.md');
  if (existsSync(sidecarPath)) {
    return _extractYamlFromSidecar(await readFile(sidecarPath, 'utf8'));
  }
  // Fall back to dryRun
  try {
    const { FeatureManager } = await import(join(projectRoot, 'features/index.js'));
    const yamls = await FeatureManager.deploy(featureName, config, { dryRun: true });
    return yamls || [];
  } catch (_err) {
    return [];
  }
}

function _extractYamlFromSidecar(content) {
  const yamlBlocks = [];
  const regex = /```ya?ml\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    yamlBlocks.push(match[1]);
  }
  return yamlBlocks;
}

async function _extractTestSection(yamlFilePath) {
  const mdPath = yamlFilePath.replace(/\.yaml$/, '.md');
  if (!existsSync(mdPath)) return null;

  const content = await readFile(mdPath, 'utf8');
  const runningMatch = content.match(/##\s+Running\n([\s\S]*?)(?:\n##|\s*$)/);
  if (runningMatch) return runningMatch[1].trim();

  return null;
}

function _formatTitle(name) {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Render a usecase's spec.tests array as readable prose: one subsection per
 * test, its setup/steps/teardown described in order. Used as the "Test It"
 * fallback when no companion .md "## Running" section exists.
 * @param {Array<object>|undefined} tests
 * @returns {string|null}
 */
function _renderTestsSection(tests) {
  if (!Array.isArray(tests) || tests.length === 0) return null;

  const lines = [];
  for (const test of tests) {
    lines.push(`#### ${_formatTitle(test.name || 'test')}`);
    lines.push('');
    if (test.description) {
      lines.push(test.description.trim());
      lines.push('');
    }
    if (test.setup?.length > 0) {
      lines.push(`**Setup:** ${test.setup.map(_describeTestStep).join('; ')}`);
      lines.push('');
    }
    const steps = (test.steps || []).map(_describeTestStep);
    steps.forEach((desc, i) => lines.push(`${i + 1}. ${desc}`));
    if (steps.length > 0) lines.push('');
    if (test.teardown?.length > 0) {
      lines.push(`**Teardown:** ${test.teardown.map(_describeTestStep).join('; ')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Describe one test step in prose. send-request and verify (the two steps
 * every usecase test uses) get dedicated phrasing; every other action
 * (scale-deployment, set-budget, get-token, ...) falls back to a generic
 * `action`: key=value list so no step type is silently dropped.
 * @param {object} step
 * @returns {string}
 */
function _describeTestStep(step) {
  switch (step.action) {
    case 'send-request': {
      const target = step.endpoint ? `\`POST ${step.endpoint}\`` : 'the gateway';
      if (step.prompt) return `Send ${target} with prompt: "${step.prompt}"`;
      if (step.body) return `Send ${target} with body: \`${JSON.stringify(step.body)}\``;
      return `Send a request to ${target}`;
    }
    case 'verify':
      return `Expect: ${_describeExpect(step.expect || {})}`;
    default: {
      const fields = Object.entries(step)
        .filter(([key]) => key !== 'action')
        .map(
          ([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`
        )
        .join(', ');
      return fields ? `\`${step.action}\`: ${fields}` : `\`${step.action}\``;
    }
  }
}

/** Describe a verify step's expect block as a compact key=value list. */
function _describeExpect(expect) {
  const parts = [];
  if (expect.status !== undefined) parts.push(`status=${expect.status}`);
  if (expect.statusCode !== undefined) parts.push(`statusCode=${expect.statusCode}`);
  if (expect.reason) parts.push(`reason="${expect.reason}"`);
  if (expect.contains) parts.push(`contains=${JSON.stringify(expect.contains)}`);
  if (expect.notContains) parts.push(`notContains=${JSON.stringify(expect.notContains)}`);
  if (expect.piiRedacted) parts.push('piiRedacted=true');
  if (expect.connectionError) parts.push('connectionError=true');
  if (expect.mcpResult) parts.push(`mcpResult=${JSON.stringify(expect.mcpResult)}`);
  if (expect.headers) parts.push(`headers=${JSON.stringify(expect.headers)}`);
  return parts.join(', ') || '(no assertions)';
}
