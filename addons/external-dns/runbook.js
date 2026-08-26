// addons/external-dns/runbook.js

const EXTERNAL_DNS_VERSION = '1.21.1';

export function envVarsFor(_cfg) {
  // Route53 access is via IRSA on the external-dns service account, so there are
  // no credential env vars to export here.
  return [];
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  const exports = [
    { key: 'EXTERNAL_DNS_VERSION', value: c.version || EXTERNAL_DNS_VERSION, group: 'versions' },
    { key: 'EXTERNAL_DNS_NAMESPACE', value: c.namespace || 'external-dns', group: 'settings' },
    { key: 'EXTERNAL_DNS_REGION', value: c.region || 'ap-southeast-2', group: 'settings' },
    {
      key: 'EXTERNAL_DNS_DOMAIN_FILTER',
      value: c.domainFilter || '<DOMAIN_FILTER>',
      group: 'settings',
    },
    {
      key: 'EXTERNAL_DNS_TXT_OWNER_ID',
      value: c.txtOwnerId || 'agentgateway-demo',
      group: 'settings',
    },
  ];
  if (c.zoneId) {
    exports.push({ key: 'EXTERNAL_DNS_ZONE_ID', value: c.zoneId, group: 'settings' });
  }
  return exports;
}

export async function generate(_subIndex, profileAddonConfig) {
  const cfg = profileAddonConfig || {};

  const lines = [];
  lines.push('### Install external-dns');
  lines.push('');
  lines.push('Installs external-dns for automatic DNS record management via AWS Route53.');
  lines.push('');
  lines.push('#### Install external-dns');
  lines.push('');
  lines.push('```bash');
  lines.push('helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/');
  lines.push('helm repo update external-dns');
  lines.push('');
  lines.push('helm upgrade -i external-dns external-dns/external-dns \\');
  lines.push('  -n ${EXTERNAL_DNS_NAMESPACE} \\');
  lines.push('  --version ${EXTERNAL_DNS_VERSION} \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait \\');
  lines.push('  --set provider.name=aws \\');
  lines.push('  --set env[0].name=AWS_DEFAULT_REGION \\');
  lines.push('  --set env[0].value=${EXTERNAL_DNS_REGION} \\');
  lines.push('  --set domainFilters[0]=${EXTERNAL_DNS_DOMAIN_FILTER} \\');
  lines.push('  --set txtOwnerId=${EXTERNAL_DNS_TXT_OWNER_ID} \\');
  lines.push('  --set policy=sync \\');
  lines.push('  --set sources[0]=service \\');
  lines.push('  --set sources[1]=ingress \\');
  lines.push('  --set sources[2]=gateway-httproute \\');
  if (cfg.zoneId) {
    lines.push('  --set extraArgs[0]=--aws-zone-type=public \\');
    lines.push('  --set extraArgs[1]=--zone-id-filter=${EXTERNAL_DNS_ZONE_ID}');
  } else {
    lines.push('  --set extraArgs[0]=--aws-zone-type=public');
  }
  lines.push('```');
  lines.push('');
  lines.push('#### Wait for external-dns to be ready');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'kubectl rollout status deployment/external-dns -n ${EXTERNAL_DNS_NAMESPACE} --timeout=120s'
  );
  lines.push('```');

  return lines.join('\n');
}

export function cleanup(_cfg) {
  return ['```bash', 'helm uninstall external-dns -n ${EXTERNAL_DNS_NAMESPACE}', '```'].join('\n');
}
