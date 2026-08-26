// addons/solo-ui/runbook.js

export function envVarsFor(_cfg) {
  return [];
}

export function envExportsFor(_cfg) {
  return [
    { key: 'SOLO_UI_VERSION', value: '0.3.13', group: 'versions' },
    { key: 'SOLO_UI_NAMESPACE', value: 'agentgateway-system', group: 'settings' },
  ];
}

export async function generate(_subIndex, _cfg) {
  const lines = [];
  lines.push('### Install Solo UI');
  lines.push('');
  lines.push('Installs the Solo UI management console (includes ClickHouse).');
  lines.push('');
  lines.push('#### Install Solo UI CRDs');
  lines.push('');
  lines.push('```bash');
  lines.push('helm upgrade -i solo-ui-crds \\');
  lines.push(
    '  oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management-crds \\'
  );
  lines.push('  -n ${SOLO_UI_NAMESPACE} \\');
  lines.push('  --version ${SOLO_UI_VERSION} \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait --timeout 5m');
  lines.push('```');
  lines.push('');
  lines.push('#### Install Solo UI');
  lines.push('');
  lines.push('```bash');
  lines.push('helm upgrade -i solo-ui \\');
  lines.push('  oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management \\');
  lines.push('  -n ${SOLO_UI_NAMESPACE} \\');
  lines.push('  --version ${SOLO_UI_VERSION} \\');
  lines.push('  -f addons/solo-ui/config/values.yaml \\');
  lines.push('  --create-namespace \\');
  lines.push('  --set management-crds.enabled=false \\');
  lines.push('  --set licensing.licenseKey=$ENTERPRISE_AGENTGATEWAY_LICENSE \\');
  lines.push('  --wait --timeout 10m');
  lines.push('```');
  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'helm uninstall solo-ui -n ${SOLO_UI_NAMESPACE}',
    'helm uninstall solo-ui-crds -n ${SOLO_UI_NAMESPACE}',
    '```',
  ].join('\n');
}
