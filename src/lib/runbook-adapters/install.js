// src/lib/runbook-adapters/install.js
import { readFile } from 'fs/promises';
import { join } from 'path';
import yaml from 'js-yaml';
import {
  EDITION_BASE_NAME,
  EDITION_RELEASE_NAME,
  EDITION_OCI_REGISTRY,
  resolveEdition,
} from '../editions.js';

// Defaults mirror src/lib/agentgateway.js constants
const AGW_VERSION = process.env.AGENTGATEWAY_VERSION || '2.1.1';
const AGW_NAMESPACE = process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system';
const GATEWAY_API_VERSION = process.env.GATEWAY_API_VERSION || 'v1.4.0';

/**
 * Resolve version/registry/release fields from optional profile data.
 * @param {object|null} profileData
 * @returns {{ edition, version, ociRegistry, gatewayApiVersion, gatewayApiChannel, crdsVersion, crdsOciRegistry, releaseName, chartName, crdsReleaseName, crdsChartName }}
 */
function _resolveVersions(profileData) {
  const edition = resolveEdition(profileData?.edition);
  const baseName = EDITION_BASE_NAME[edition];
  const defaultOciRegistry = EDITION_OCI_REGISTRY[edition];
  const ociRegistry = profileData?.agentgateway?.ociRegistry ?? defaultOciRegistry;
  return {
    edition,
    version: profileData?.agentgateway?.version ?? AGW_VERSION,
    ociRegistry,
    gatewayApiVersion: profileData?.gatewayApi?.version ?? GATEWAY_API_VERSION,
    gatewayApiChannel: profileData?.gatewayApi?.channel ?? 'standard',
    crdsVersion:
      profileData?.['agentgateway-crds']?.version ??
      profileData?.agentgateway?.version ??
      AGW_VERSION,
    crdsOciRegistry: profileData?.['agentgateway-crds']?.ociRegistry ?? ociRegistry,
    releaseName: process.env.AGENTGATEWAY_RELEASE || EDITION_RELEASE_NAME[edition],
    chartName: baseName,
    crdsReleaseName: process.env.AGENTGATEWAY_CRDS_RELEASE || `${baseName}-crds`,
    crdsChartName: `${baseName}-crds`,
  };
}

export const InstallAdapter = {
  /**
   * Env vars required for the installation section.
   * @param {object|null} profileData
   */
  envVars(profileData = null) {
    const { edition } = _resolveVersions(profileData);
    return [
      {
        name: 'ENTERPRISE_AGENTGATEWAY_LICENSE',
        required: edition !== 'opensource',
        description: 'Enterprise Agentgateway license key from Solo.io',
      },
    ];
  },

  /**
   * Return env export objects for the consolidated env vars section.
   * @param {object|null} profileData
   * @returns {Array<{key: string, value: string, group: string}>}
   */
  envExports(profileData = null) {
    const { version, crdsVersion, ociRegistry, gatewayApiVersion, releaseName, crdsReleaseName } =
      _resolveVersions(profileData);
    const exports = [
      { key: 'AGW_VERSION', value: version, group: 'versions' },
      { key: 'AGW_OCI_REGISTRY', value: ociRegistry, group: 'registry' },
      { key: 'GATEWAY_API_VERSION', value: gatewayApiVersion, group: 'versions' },
      { key: 'AGW_NAMESPACE', value: AGW_NAMESPACE, group: 'settings' },
      { key: 'AGW_RELEASE', value: releaseName, group: 'settings' },
      { key: 'AGW_CRDS_RELEASE', value: crdsReleaseName, group: 'settings' },
    ];
    if (crdsVersion !== version) {
      exports.splice(1, 0, { key: 'AGW_CRDS_VERSION', value: crdsVersion, group: 'versions' });
    }
    return exports;
  },

  /**
   * Generate the Installation lab section markdown.
   * @param {{ addons?: string[], labNum?: number, profileData?: object|null }} opts
   * @returns {Promise<string>}
   */
  async generate({
    addons = [],
    labNum = 0,
    profileData = null,
    projectRoot = process.cwd(),
    envExports = [],
  } = {}) {
    const {
      edition,
      version,
      ociRegistry,
      gatewayApiVersion,
      gatewayApiChannel,
      crdsVersion,
      chartName,
      crdsChartName,
    } = _resolveVersions(profileData);

    const installFile =
      gatewayApiChannel === 'experimental' ? 'experimental-install.yaml' : 'standard-install.yaml';
    const channelLabel = gatewayApiChannel === 'experimental' ? 'experimental' : 'standard';

    const sections = [];

    sections.push(`## Lab ${labNum}: Installation`);
    sections.push('');
    sections.push('Install the Agentgateway control plane and required CRDs into your cluster.');

    // Gateway API CRDs
    sections.push('');
    sections.push('### Install Gateway API CRDs');
    sections.push('');
    sections.push(`Install the Gateway API ${channelLabel} channel CRDs (${gatewayApiVersion}):`);
    sections.push('');
    sections.push('```bash');
    sections.push(
      `kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/\${GATEWAY_API_VERSION}/${installFile}`
    );
    sections.push('```');

    // AGW CRDs
    const crdsVersionVar = crdsVersion !== version ? '${AGW_CRDS_VERSION}' : '${AGW_VERSION}';
    sections.push('');
    sections.push('### Install Agentgateway CRDs');
    sections.push('');
    sections.push('```bash');
    sections.push(
      `kubectl create namespace \${AGW_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`
    );
    sections.push('');
    sections.push(`helm upgrade -i --create-namespace \\`);
    sections.push(`  --namespace \${AGW_NAMESPACE} \\`);
    sections.push(`  --version ${crdsVersionVar} \\`);
    sections.push(`  \${AGW_CRDS_RELEASE} \\`);
    sections.push(`  \${AGW_OCI_REGISTRY}/${crdsChartName}`);
    sections.push('```');

    // AGW chart
    sections.push('');
    sections.push('### Install Agentgateway');
    sections.push('');

    const hasHelmValues =
      profileData?.helmValues != null && Object.keys(profileData.helmValues).length > 0;

    sections.push('```bash');
    sections.push(`helm upgrade -i \\`);
    sections.push(`  -n \${AGW_NAMESPACE} \\`);
    sections.push(`  \${AGW_RELEASE} \\`);
    sections.push(`  \${AGW_OCI_REGISTRY}/${chartName} \\`);
    sections.push(`  --version \${AGW_VERSION} \\`);

    const licenseLine = `  --set licensing.licenseKey=$ENTERPRISE_AGENTGATEWAY_LICENSE \\`;

    if (hasHelmValues) {
      // Strip licensing key before dumping so the license key never appears in docs
      const { licensing: _licensing, ...safeHelmValues } = profileData.helmValues;
      let helmValuesYaml = yaml.dump(safeHelmValues, { indent: 2 }).trimEnd();
      // Replace hardcoded namespace with shell variable
      helmValuesYaml = helmValuesYaml.replaceAll('agentgateway-system', '${AGW_NAMESPACE}');
      // Reverse-substitute resolved endpoint values with their env var references
      for (const e of envExports) {
        if (e.group === 'endpoints' && e.value && !e.value.startsWith('<')) {
          helmValuesYaml = helmValuesYaml.replaceAll(e.value, `\${${e.key}}`);
        }
      }
      if (edition !== 'opensource') sections.push(licenseLine);
      sections.push(`  --values - <<EOF`);
      sections.push(helmValuesYaml);
      sections.push('EOF');
    } else {
      if (edition !== 'opensource') sections.push(licenseLine);
      sections.push(`  --wait --timeout 5m`);
    }
    sections.push('```');

    // Additional resources (profile-specific)
    if (profileData?.resources?.length > 0) {
      sections.push('');
      sections.push('### Apply Additional Resources');
      sections.push('');
      sections.push('Apply the following profile-specific resources:');
      sections.push('');
      for (const resource of profileData.resources) {
        const resourcePath = join(projectRoot, 'config', 'profiles', resource);
        let content;
        try {
          content = await readFile(resourcePath, 'utf8');
        } catch {
          sections.push(`# (resource not found: config/profiles/${resource})`);
          continue;
        }
        const processedContent = content
          .trimEnd()
          .replaceAll('agentgateway-system', '${AGW_NAMESPACE}');
        sections.push('```bash');
        sections.push(`kubectl apply -f - <<EOF`);
        sections.push(processedContent);
        sections.push('EOF');
        sections.push('```');
      }
    }

    return sections.join('\n');
  },

  /**
   * Return component version info for the versions table.
   * @param {object|null} profileData
   * @returns {{ agwVersion: string, gatewayApiVersion: string, agwOci: string }}
   */
  versions(profileData = null) {
    const {
      edition,
      version,
      ociRegistry,
      gatewayApiVersion,
      gatewayApiChannel,
      releaseName,
      crdsReleaseName,
    } = _resolveVersions(profileData);
    return {
      edition,
      agwVersion: version,
      gatewayApiVersion,
      gatewayApiChannel,
      agwOci: ociRegistry,
      agwRelease: releaseName,
      agwCrdsRelease: crdsReleaseName,
      agwNamespace: AGW_NAMESPACE,
    };
  },
};
