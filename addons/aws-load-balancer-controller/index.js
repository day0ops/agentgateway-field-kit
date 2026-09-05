import { Feature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const HELM_REPO_NAME = 'eks';
const HELM_REPO_URL = 'https://aws.github.io/eks-charts';
const RELEASE_NAME = 'aws-load-balancer-controller';
const DEFAULT_CHART_VERSION = '3.5.0';

/**
 * Installs the AWS Load Balancer Controller (IRSA-backed), which provisions real
 * NLBs/ALBs with their own security groups - unlike the in-tree Classic ELB
 * controller, which opens NodePorts directly on the shared worker security group.
 * https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/installation/
 *
 * Configuration:
 * {
 *   namespace: string,              // Default: 'kube-system'
 *   version: string,                // Helm chart version, default: '3.5.0'
 *   clusterName: string,            // Required: real EKS cluster name
 *   serviceAccountRoleArn: string,  // Required: IRSA role ARN
 *   vpcId: string,                  // Optional
 * }
 */
export class AwsLoadBalancerControllerFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.namespace = config.namespace || 'kube-system';
    this.chartVersion = config.version || DEFAULT_CHART_VERSION;
    this.serviceAccountRoleArn = config.serviceAccountRoleArn || null;
    this.clusterName = config.clusterName || null;
    this.vpcId = config.vpcId || null;
  }

  validate() {
    if (!this.serviceAccountRoleArn) {
      this.log('serviceAccountRoleArn is required for aws-load-balancer-controller', 'error');
      return false;
    }
    if (!this.clusterName) {
      this.log('clusterName is required for aws-load-balancer-controller', 'error');
      return false;
    }
    return true;
  }

  async deploy() {
    this.log('Installing AWS Load Balancer Controller...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner);
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    await this.addHelmRepo();
    await this.installController();
    await this.waitForController();

    this.log('AWS Load Balancer Controller installed successfully', 'success');
  }

  async addHelmRepo() {
    this.log('Adding EKS Helm repository...', 'info');

    try {
      await CommandRunner.run('helm', ['repo', 'add', HELM_REPO_NAME, HELM_REPO_URL], {
        ignoreError: true,
      }); // Ignore if repo already exists

      await CommandRunner.run('helm', ['repo', 'update', HELM_REPO_NAME]);

      this.log('EKS Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add Helm repository: ${error.message}`, { cause: error });
    }
  }

  async installController() {
    this.log('Installing AWS Load Balancer Controller Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      `${HELM_REPO_NAME}/aws-load-balancer-controller`,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--set',
      `clusterName=${this.clusterName}`,
      '--set',
      `serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=${this.serviceAccountRoleArn}`,
      '--wait',
    ];

    if (this.vpcId) {
      helmArgs.push('--set', `vpcId=${this.vpcId}`);
    }

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    this.log('AWS Load Balancer Controller Helm chart installed', 'info');
  }

  async waitForController() {
    this.log('Waiting for AWS Load Balancer Controller to be ready...', 'info');

    try {
      await KubernetesHelper.waitForDeployment(this.namespace, RELEASE_NAME, 300, this.spinner);
    } catch (error) {
      this.log(`Warning: AWS Load Balancer Controller may not be ready: ${error.message}`, 'warn');
    }

    this.log('AWS Load Balancer Controller is ready', 'info');
  }

  async cleanup() {
    this.log('Cleaning up AWS Load Balancer Controller...', 'info');

    try {
      await CommandRunner.run('helm', ['uninstall', RELEASE_NAME, '-n', this.namespace], {
        ignoreError: true,
      });
      this.log('AWS Load Balancer Controller Helm chart uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    this.log('AWS Load Balancer Controller cleaned up', 'success');
  }
}
