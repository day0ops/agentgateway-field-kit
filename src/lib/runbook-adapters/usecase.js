// src/lib/runbook-adapters/usecase.js
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { UseCaseManager } from '../usecase.js';

export const UseCaseAdapter = {
  /**
   * Generate a lab section from a use case YAML.
   * @param {{ name: string, labNum: number, deployedProviders: string[], projectRoot?: string }} opts
   * @returns {Promise<string>}
   */
  async generate({ name, labNum, deployedProviders = [], projectRoot = process.cwd() }) {
    const ucMeta = await UseCaseManager.get(name, projectRoot);
    const ucData = await UseCaseManager.parse(ucMeta.file);
    const { metadata, spec } = ucData;

    const steps = UseCaseManager.getSteps(spec);
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
        if (featureRef.name === 'providers') {
          // Skip — providers are defined in Lab 1
          lines.push('> Providers already deployed in Lab 1. No action required.');
          lines.push('');
          continue;
        }

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

    // Test It — from companion .md "## Running" section
    const testSection = await _extractTestSection(ucMeta.file);
    if (testSection) {
      lines.push('### Test It');
      lines.push('');
      lines.push(testSection.trim());
      lines.push('');
    }

    return lines.join('\n');
  },
};

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
