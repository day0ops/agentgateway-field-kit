import { CommandRunner, Logger, SpinnerLogger } from './common.js';

const CLUSTER_NAME = process.env.CLUSTER_NAME || 'agentgateway-demo';
const LOK8S_MEMORY = process.env.LOK8S_MEMORY || '12288';
const LOK8S_CPUS = process.env.LOK8S_CPUS || '6';
const KUBERNETES_VERSION = process.env.KUBERNETES_VERSION || '1.34.0';

export class Lok8sManager {
  static async checkInstalled() {
    try {
      await CommandRunner.run('lok8s', ['version'], { ignoreError: true });
      Logger.success('lok8s is installed');
      return true;
    } catch {
      Logger.error('lok8s is not installed');
      Logger.info('Install lok8s: https://github.com/day0ops/lok8s');
      return false;
    }
  }

  static async start() {
    Logger.info(`Starting lok8s cluster: ${CLUSTER_NAME}`);
    Logger.warn('This command requires sudo access and may prompt for your password');

    // Prompt for sudo password early to cache credentials
    try {
      await CommandRunner.run('sudo', ['-v']);
    } catch (error) {
      Logger.error('Failed to obtain sudo privileges');
      throw error;
    }

    const spinner = new SpinnerLogger();
    spinner.start('Creating new lok8s cluster...');

    try {
      await CommandRunner.run('lok8s', [
        'create',
        '-p',
        CLUSTER_NAME,
        `--memory=${LOK8S_MEMORY}`,
        `--cpu=${LOK8S_CPUS}`,
        `--kubernetes-version=${KUBERNETES_VERSION}`,
      ]);

      spinner.succeed('Lok8s cluster created and started');

      // Set kubectl context
      await CommandRunner.run('kubectl', ['config', 'use-context', CLUSTER_NAME]);
      Logger.success(`kubectl context set to ${CLUSTER_NAME}`);
    } catch (error) {
      spinner.fail('Failed to start lok8s');
      throw error;
    }
  }

  static async stop() {
    const spinner = new SpinnerLogger();
    spinner.start(`Stopping lok8s cluster: ${CLUSTER_NAME}`);

    try {
      await CommandRunner.run('lok8s', ['stop', '-p', CLUSTER_NAME]);
      spinner.succeed('Cluster stopped');
    } catch (error) {
      spinner.fail('Failed to stop cluster');
      throw error;
    }
  }

  static async delete() {
    Logger.info(`Deleting lok8s cluster: ${CLUSTER_NAME}`);

    try {
      await CommandRunner.run('lok8s', ['status', '-p', CLUSTER_NAME], {
        ignoreError: true,
      });
    } catch {
      Logger.warn(`Cluster ${CLUSTER_NAME} does not exist`);
      return;
    }

    const spinner = new SpinnerLogger();
    spinner.start('Deleting cluster...');

    try {
      await CommandRunner.run('lok8s', ['delete', '-p', CLUSTER_NAME]);
      spinner.succeed('Cluster deleted');
    } catch (error) {
      spinner.fail('Failed to delete cluster');
      throw error;
    }
  }

  //   static async status() {
  //     try {
  //       await CommandRunner.run('lok8s', ['status', '-p', CLUSTER_NAME], {
  //         ignoreError: true
  //       });
  //     } catch {
  //       Logger.info(`Cluster ${CLUSTER_NAME} does not exist`);
  //       return;
  //     }

  //     Logger.info('Cluster status:');
  //     const result = await CommandRunner.run('lok8s', ['status', '-p', CLUSTER_NAME]);
  //     console.log(result.stdout);
  //   }

  static async getIP() {
    try {
      await CommandRunner.run('lok8s', ['status', '-p', CLUSTER_NAME], {
        ignoreError: true,
      });
    } catch {
      Logger.error(`Cluster ${CLUSTER_NAME} does not exist`);
      throw new Error('Cluster not found');
    }

    const result = await CommandRunner.run('lok8s', ['ip', '-p', CLUSTER_NAME]);
    return result.stdout.trim();
  }
}
