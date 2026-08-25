// addons/cert-manager/runbook.js

export function envVarsFor(_cfg) {
  return [];
}

export function envExportsFor(_cfg) {
  return [
    { key: 'CERT_MANAGER_VERSION', value: 'v1.19.3', group: 'versions' },
    { key: 'CERT_MANAGER_NAMESPACE', value: 'cert-manager', group: 'settings' },
  ];
}

export async function generate(_subIndex, _cfg) {
  const lines = [];
  lines.push('### Install Certificate Manager');
  lines.push('');
  lines.push('Installs cert-manager for automated TLS certificate management.');
  lines.push('');
  lines.push('#### Install cert-manager CRDs');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.crds.yaml'
  );
  lines.push('```');
  lines.push('');
  lines.push('#### Install cert-manager');
  lines.push('');
  lines.push('```bash');
  lines.push('helm repo add jetstack https://charts.jetstack.io');
  lines.push('helm repo update');
  lines.push('');
  lines.push('helm upgrade -i cert-manager jetstack/cert-manager \\');
  lines.push('  -n ${CERT_MANAGER_NAMESPACE} \\');
  lines.push('  --version ${CERT_MANAGER_VERSION} \\');
  lines.push('  -f addons/cert-manager/config/values.yaml \\');
  lines.push('  --create-namespace \\');
  lines.push('  --wait --timeout 5m');
  lines.push('```');
  lines.push('');
  lines.push('#### Create ClusterIssuers');
  lines.push('');
  lines.push('```bash');
  lines.push("kubectl apply -f - <<'EOF'");
  lines.push('apiVersion: cert-manager.io/v1');
  lines.push('kind: ClusterIssuer');
  lines.push('metadata:');
  lines.push('  name: selfsigned-issuer');
  lines.push('spec:');
  lines.push('  selfSigned: {}');
  lines.push('EOF');
  lines.push('```');
  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'helm uninstall cert-manager -n ${CERT_MANAGER_NAMESPACE}',
    'kubectl delete namespace ${CERT_MANAGER_NAMESPACE} --ignore-not-found',
    '```',
  ].join('\n');
}
