import { join } from 'path';

const PROVIDER_ENV_VARS = {
  openai: [{ name: 'OPENAI_API_KEY', required: true, description: 'OpenAI API key' }],
  anthropic: [{ name: 'ANTHROPIC_API_KEY', required: true, description: 'Anthropic API key' }],
  bedrock: [
    { name: 'AWS_ACCESS_KEY_ID', required: true, description: 'AWS access key ID' },
    { name: 'AWS_SECRET_ACCESS_KEY', required: true, description: 'AWS secret access key' },
  ],
  'vertex-ai': [
    {
      name: 'GOOGLE_APPLICATION_CREDENTIALS',
      required: true,
      description: 'Path to GCP service account JSON',
    },
    { name: 'GCP_PROJECT', required: true, description: 'GCP project ID' },
    { name: 'GCP_LOCATION', required: false, description: 'GCP region (default: us-central1)' },
  ],
  azure: [
    { name: 'AZURE_OPENAI_API_KEY', required: true, description: 'Azure OpenAI API key' },
    { name: 'AZURE_OPENAI_ENDPOINT', required: true, description: 'Azure OpenAI endpoint URL' },
  ],
};

const PROVIDER_CONFIGS = {
  openai: { providerName: 'openai', pathPrefix: '/openai', model: 'gpt-4o-mini' },
  anthropic: {
    providerName: 'anthropic',
    pathPrefix: '/anthropic',
    model: 'claude-3-haiku-20240307',
  },
  bedrock: { providerName: 'bedrock', pathPrefix: '/bedrock', region: 'us-east-1' },
  'vertex-ai': { providerName: 'vertex-ai', pathPrefix: '/vertex-ai' },
  azure: { providerName: 'azure', pathPrefix: '/azure' },
};

export const ProviderAdapter = {
  /**
   * Return env vars required for the selected providers.
   * @param {string[]} providerNames
   */
  envVarsFor(providerNames) {
    const seen = new Set();
    const result = [];
    for (const name of providerNames) {
      const vars = PROVIDER_ENV_VARS[name] || [];
      for (const v of vars) {
        if (!seen.has(v.name)) {
          seen.add(v.name);
          result.push(v);
        }
      }
    }
    return result;
  },

  /**
   * Generate the Providers lab section using dryRun mode.
   * Temporarily sets env vars to placeholder values during dryRun so no
   * real credentials appear in the output.
   * @param {string[]} providerNames
   * @param {number} labNum
   * @param {string} [projectRoot]
   * @returns {Promise<string>}
   */
  async generate(providerNames, labNum, projectRoot = process.cwd()) {
    const lines = [];
    lines.push(`## Lab ${labNum}: Providers`);
    lines.push('');
    lines.push(
      '> Deploy once. All subsequent labs reference these routes — no redeployment needed.'
    );

    for (const providerName of providerNames) {
      const config = PROVIDER_CONFIGS[providerName];
      if (!config) continue;

      lines.push('');
      lines.push(`### Deploy ${_titleCase(providerName)}`);
      lines.push('');

      // Run dryRun with placeholder env vars to generate YAML without real credentials
      const yamlDocs = await _dryRunProvider(providerName, config, projectRoot);

      if (yamlDocs.length > 0) {
        lines.push('Apply the following manifests:');
        lines.push('');
        for (const doc of yamlDocs) {
          lines.push('```yaml');
          lines.push(doc.trim());
          lines.push('```');
          lines.push('');
        }
      } else {
        lines.push('```bash');
        lines.push(`# Provider ${providerName} configured via agw CLI`);
        lines.push(`agw feature deploy providers`);
        lines.push('```');
      }
    }

    return lines.join('\n');
  },
};

async function _dryRunProvider(providerName, providerConfig, projectRoot) {
  // Save and override env vars with placeholders so dryRun YAML is clean
  const envOverrides = {};
  for (const v of PROVIDER_ENV_VARS[providerName] || []) {
    envOverrides[v.name] = process.env[v.name];
    if (!process.env[v.name]) {
      process.env[v.name] = `<${v.name}>`;
    }
  }

  let yamls = [];
  try {
    const { FeatureManager } = await import(join(projectRoot, 'features/index.js'));
    yamls = await FeatureManager.deploy(
      'providers',
      { providers: [{ name: providerName, ...providerConfig }] },
      { dryRun: true }
    );
  } catch (_err) {
    // dryRun failures are non-fatal — fall back to empty
  } finally {
    // Restore env vars
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return yamls;
}

function _titleCase(str) {
  return str
    .split('-')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
