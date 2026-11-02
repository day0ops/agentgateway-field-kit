// addons/cert-manager/runbook.js

export function envVarsFor(cfg) {
  const c = cfg || {};
  if (c.letsencrypt?.enabled && (c.letsencrypt?.provider || 'route53') === 'cloudflare') {
    return [
      {
        name: 'CLOUDFLARE_API_TOKEN',
        required: true,
        description: "Cloudflare API token for the letsencrypt-dns ClusterIssuer's DNS-01 solver",
      },
    ];
  }
  return [];
}

export function envExportsFor(cfg) {
  const c = cfg || {};
  const exports = [
    { key: 'CERT_MANAGER_VERSION', value: 'v1.21.2', group: 'versions' },
    { key: 'CERT_MANAGER_NAMESPACE', value: 'cert-manager', group: 'settings' },
  ];
  if (c.letsencrypt?.enabled) {
    exports.push({
      key: 'CERT_MANAGER_ACME_EMAIL',
      value: c.letsencrypt.email || '<ACME_EMAIL>',
      group: 'settings',
    });
  }
  return exports;
}

export async function generate(_subIndex, cfg) {
  const c = cfg || {};
  const letsencryptEnabled = c.letsencrypt?.enabled === true;
  const provider = c.letsencrypt?.provider || 'route53';

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

  if (letsencryptEnabled) {
    lines.push('');
    if (provider === 'cloudflare') {
      lines.push('#### Create the Cloudflare API token secret');
      lines.push('');
      lines.push('```bash');
      lines.push(
        'kubectl create secret generic cert-manager-cloudflare-api-token -n ${CERT_MANAGER_NAMESPACE} \\'
      );
      lines.push('  --from-literal=api-token="${CLOUDFLARE_API_TOKEN}" \\');
      lines.push('  --dry-run=client -o yaml | kubectl apply -f -');
      lines.push('```');
      lines.push('');
    }
    lines.push("#### Create the Let's Encrypt DNS-01 ClusterIssuer");
    lines.push('');
    lines.push('```bash');
    lines.push("kubectl apply -f - <<'EOF'");
    lines.push('apiVersion: cert-manager.io/v1');
    lines.push('kind: ClusterIssuer');
    lines.push('metadata:');
    lines.push('  name: letsencrypt-dns');
    lines.push('spec:');
    lines.push('  acme:');
    lines.push('    server: https://acme-v02.api.letsencrypt.org/directory');
    lines.push('    email: ${CERT_MANAGER_ACME_EMAIL}');
    lines.push('    privateKeySecretRef:');
    lines.push('      name: letsencrypt-dns');
    lines.push('    solvers:');
    if (provider === 'cloudflare') {
      lines.push('      - dns01:');
      lines.push('          cloudflare:');
      lines.push('            apiTokenSecretRef:');
      lines.push('              name: cert-manager-cloudflare-api-token');
      lines.push('              key: api-token');
    } else {
      lines.push('      - dns01:');
      lines.push('          route53:');
      lines.push('            region: us-east-1');
    }
    lines.push('EOF');
    lines.push('```');
  }

  return lines.join('\n');
}

export function cleanup(cfg) {
  const letsencryptEnabled = cfg?.letsencrypt?.enabled === true;
  const lines = ['```bash', 'helm uninstall cert-manager -n ${CERT_MANAGER_NAMESPACE}'];
  if (letsencryptEnabled) {
    lines.push('kubectl delete clusterissuer letsencrypt-dns --ignore-not-found');
  }
  lines.push('kubectl delete namespace ${CERT_MANAGER_NAMESPACE} --ignore-not-found');
  lines.push('```');
  return lines.join('\n');
}
