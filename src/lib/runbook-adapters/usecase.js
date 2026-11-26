// src/lib/runbook-adapters/usecase.js
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { UseCaseManager } from '../usecase.js';
import { EnvironmentManager } from '../environment.js';
import { UseCaseTestRunner } from '../usecase-tests.js';

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
 * Render a usecase's spec.tests array as readable, runnable prose: one
 * subsection per test, its setup/teardown as blockquotes and its steps as
 * real curl commands with the expected outcome called out. Used as the
 * "Test It" fallback when no companion .md "## Running" section exists.
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
      lines.push(`> **Setup:** ${test.setup.map(_describeTestStep).join('; ')}`);
      lines.push('');
    }
    for (const step of test.steps || []) {
      lines.push(..._renderStepBlock(step));
    }
    if (test.teardown?.length > 0) {
      lines.push(`> **Teardown:** ${test.teardown.map(_describeTestStep).join('; ')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Render one test step as markdown lines: send-request becomes a runnable
 * curl command against ${AGW_GATEWAY_URL} (set up in Lab 0's gateway access
 * instructions), verify becomes a one-line "Expect:" summary, and every
 * other action (scale-deployment, set-budget, get-token, ...) falls back to
 * the same generic key=value description used for setup/teardown.
 * @param {object} step
 * @returns {string[]}
 */
function _renderStepBlock(step) {
  if (step.action === 'send-request') {
    const lines = ['**Send:**', ''];
    if (step.tls) {
      lines.push(
        '_(this step requires a client certificate via `step.tls` - see the usecase YAML for the exact material; the command below omits it and will fail the TLS handshake as shown)_',
        ''
      );
    }
    lines.push('```bash', ..._buildCurlCommand(step), '```', '');
    return lines;
  }
  if (step.action === 'verify') {
    return [`**Expect:** ${_describeExpect(step.expect || {})}`, ''];
  }
  return [`- ${_describeTestStep(step)}`, ''];
}

/**
 * Build a curl command for a send-request step, from the same
 * UseCaseTestRunner.buildHttpRequestSpec() the real test runner uses - so the
 * command actually matches what gets sent (headers, model/input/extraFields,
 * scheme/port), not a hand-approximated subset of it. Adds -k for https steps
 * (demo certs are typically self-signed, matching the real runner's own
 * fallback when no CA was supplied), --connect-to for step.resolve (SNI
 * pinning), and placeholder auth headers for step.auth (the real token/cookie
 * comes from an earlier get-token/get-session-cookie step's live session
 * state, which a static runbook can't reproduce) - all presentation-only,
 * not part of what the real runner actually sends.
 * @param {object} step
 * @returns {string[]}
 */
function _buildCurlCommand(step) {
  const { method, url, headers, body, methodAllowsBody, scheme, effectivePort } =
    UseCaseTestRunner.buildHttpRequestSpec(step, { gateway: '${AGW_GATEWAY_HOST}' });

  if (step.auth === 'bearer') {
    headers.Authorization = 'Bearer <token from an earlier get-token step>';
  } else if (step.auth === 'session') {
    headers.Cookie = '<cookie from an earlier get-session-cookie step>';
  }

  const parts = [`curl -s -X ${method} "${url}"`];
  if (scheme === 'https') parts.push('-k');
  if (step.resolve) {
    parts.push(
      `--connect-to ${step.resolve.hostname}:${effectivePort}:\${AGW_GATEWAY_HOST}:${effectivePort}`
    );
  }
  for (const [key, value] of Object.entries(headers)) {
    parts.push(`-H ${_shellQuote(`${key}: ${value}`)}`);
  }
  if (methodAllowsBody) parts.push(`-d ${_shellQuote(body)}`);

  return parts.map((part, i) => {
    const isLast = i === parts.length - 1;
    const prefix = i === 0 ? '' : '  ';
    return `${prefix}${part}${isLast ? '' : ' \\'}`;
  });
}

/**
 * Quote a string for safe use as one POSIX shell word. Single-quotes by
 * default (no expansion of any kind); switches to double-quotes when the
 * value contains a literal ${VAR} placeholder (e.g. a usecase header value
 * meant to pull from the reader's own environment, matching what
 * UseCaseTestRunner.substituteEnvVarsInHeaders() does at live test-run time),
 * so the reader's shell actually substitutes it on copy-paste.
 */
function _shellQuote(value) {
  if (/\$\{\w+\}/.test(value)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`');
    return `"${escaped}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Describe one setup/teardown/fallback test step in prose as a generic
 * `action`: key=value list, so no step type is silently dropped.
 * @param {object} step
 * @returns {string}
 */
function _describeTestStep(step) {
  const fields = Object.entries(step)
    .filter(([key]) => key !== 'action')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(', ');
  return fields ? `\`${step.action}\`: ${fields}` : `\`${step.action}\``;
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
