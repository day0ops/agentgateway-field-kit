// addons/aws-load-balancer-controller/runbook.js

export function envVarsFor(_cfg) {
  return [];
}

export function envExportsFor(_cfg) {
  return [
    { key: 'AWS_LOAD_BALANCER_CONTROLLER_VERSION', value: '3.5.0', group: 'versions' },
    { key: 'AWS_LOAD_BALANCER_CONTROLLER_NAMESPACE', value: 'kube-system', group: 'settings' },
  ];
}

export async function generate(_subIndex, cfg) {
  const clusterName = cfg?.clusterName || '<eks-cluster-name>';
  const roleArn = cfg?.serviceAccountRoleArn || '<alb-controller-irsa-role-arn>';
  const vpcId = cfg?.vpcId || null;

  const lines = [];
  lines.push('### Install AWS Load Balancer Controller');
  lines.push('');
  lines.push(
    'Installs the AWS Load Balancer Controller (IRSA-backed), so gated Services can request real NLBs instead of the in-tree Classic ELB.'
  );
  lines.push('');
  lines.push('```bash');
  lines.push('helm repo add eks https://aws.github.io/eks-charts');
  lines.push('helm repo update');
  lines.push('');
  lines.push('helm upgrade -i aws-load-balancer-controller eks/aws-load-balancer-controller \\');
  lines.push('  -n ${AWS_LOAD_BALANCER_CONTROLLER_NAMESPACE} \\');
  lines.push('  --version ${AWS_LOAD_BALANCER_CONTROLLER_VERSION} \\');
  lines.push(`  --set clusterName=${clusterName} \\`);
  lines.push(
    `  --set serviceAccount.annotations."eks\\.amazonaws\\.com/role-arn"=${roleArn}${vpcId ? ' \\' : ''}`
  );
  if (vpcId) {
    lines.push(`  --set vpcId=${vpcId} \\`);
  }
  lines.push('  --wait');
  lines.push('```');
  return lines.join('\n');
}

export function cleanup(_cfg) {
  return [
    '```bash',
    'helm uninstall aws-load-balancer-controller -n ${AWS_LOAD_BALANCER_CONTROLLER_NAMESPACE}',
    '```',
  ].join('\n');
}
