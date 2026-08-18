// src/lib/runbook-adapters/feature.js
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export const FeatureAdapter = {
  /**
   * Generate a lab section for a standalone feature.
   * Priority: runbook.md sidecar > dryRun + JSDoc description.
   * @param {{ name: string, labNum: number, projectRoot?: string }} opts
   * @returns {Promise<string>}
   */
  async generate({ name, labNum, projectRoot = process.cwd() }) {
    const featureDir = join(projectRoot, 'features', name);
    if (!existsSync(featureDir)) {
      throw new Error(`Feature '${name}' not found at ${featureDir}`);
    }

    const labTitle = _formatTitle(name);
    const lines = [];
    lines.push(`## Lab ${labNum}: ${labTitle}`);
    lines.push('');

    const sidecarPath = join(featureDir, 'runbook.md');
    if (existsSync(sidecarPath)) {
      return _renderFromSidecar(lines, await readFile(sidecarPath, 'utf8'));
    }

    return _renderFromDryRun(lines, name, featureDir, projectRoot);
  },
};

function _renderFromSidecar(lines, sidecarContent) {
  // Extract narrative (everything before first ## heading)
  const yamlSectionMatch = sidecarContent.match(/##\s+YAML\n([\s\S]*?)(?:\n##|\s*$)/);
  const testSectionMatch = sidecarContent.match(/##\s+Test\n([\s\S]*?)(?:\n##|\s*$)/);

  // Narrative = everything before first ##
  const narrativeMatch = sidecarContent.match(/^([\s\S]*?)(?=\n##|\s*$)/);
  if (narrativeMatch && narrativeMatch[1].trim()) {
    lines.push(narrativeMatch[1].trim());
    lines.push('');
  }

  if (yamlSectionMatch) {
    lines.push('### Configuration');
    lines.push('');
    lines.push(yamlSectionMatch[1].trim());
    lines.push('');
  }

  if (testSectionMatch) {
    lines.push('### Test It');
    lines.push('');
    lines.push(testSectionMatch[1].trim());
    lines.push('');
  }

  return lines.join('\n');
}

async function _renderFromDryRun(lines, name, featureDir, projectRoot) {
  // Extract description from JSDoc in index.js
  const description = await _extractJsDocDescription(join(featureDir, 'index.js'));
  if (description) {
    lines.push(description);
    lines.push('');
  }

  lines.push('### Configuration');
  lines.push('');

  // dryRun with default config
  let yamls = [];
  try {
    const { FeatureManager } = await import(join(projectRoot, 'features/index.js'));
    yamls = await FeatureManager.deploy(name, {}, { dryRun: true });
  } catch (_err) {
    // dryRun failed or no feature registry — show placeholder
  }

  if (yamls && yamls.length > 0) {
    for (const doc of yamls) {
      lines.push('```yaml');
      lines.push(doc.trim());
      lines.push('```');
      lines.push('');
    }
  } else {
    lines.push('```bash');
    lines.push(`# Deploy this feature via the agw CLI`);
    lines.push(`agw feature deploy ${name}`);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

async function _extractJsDocDescription(indexPath) {
  if (!existsSync(indexPath)) return null;
  const content = await readFile(indexPath, 'utf8');

  // Extract the first JSDoc block
  const match = content.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return null;

  // Remove leading " * " from each line, strip @tags
  const lines = match[1]
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, '').trim())
    .filter(l => l && !l.startsWith('@'));

  return lines.slice(0, 6).join(' ').replace(/\s+/g, ' ').trim() || null;
}

function _formatTitle(name) {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
