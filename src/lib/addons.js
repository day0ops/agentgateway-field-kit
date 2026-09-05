import { FeatureManager } from './feature.js';
import { Logger, SpinnerLogger, formatDuration, KubernetesHelper } from './common.js';

import '../../addons/index.js';

/** Merge top-level addon fields (version, postgresVersion, …) into feature config. */
export function mergeAddonConfig(addon) {
  if (!addon) return {};
  const {
    config = {},
    namespace,
    version,
    keycloakVersion,
    postgresVersion,
    chartVersions,
    keycloakImage,
  } = addon;
  return {
    ...config,
    ...(namespace && { namespace }),
    ...(version && { version }),
    ...(keycloakVersion && { keycloakVersion }),
    ...(postgresVersion && { postgresVersion }),
    ...(chartVersions && { chartVersions }),
    ...(keycloakImage && { keycloakImage }),
  };
}

// Never delete cluster-critical or shared namespaces, even if an addon happens to be
// configured to install into one (e.g. aws-load-balancer-controller defaults to kube-system).
const PROTECTED_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'default',
  'agentgateway-system',
]);

const PROFILE_ADDONS = [
  { name: 'telemetry', namespace: 'telemetry' },
  { name: 'solo-ui', namespace: 'agentgateway-system' },
  { name: 'cert-manager', namespace: 'cert-manager' },
  { name: 'keycloak', namespace: 'keycloak' },
  { name: 'external-dns', namespace: 'external-dns' },
  { name: 'openfga', namespace: 'openfga' },
  { name: 'opa', namespace: 'opa' },
];

export class AddonInstaller {
  /**
   * Split a profile's addons into those that must install before the core agentgateway
   * proxy exists, and those whose deploy() requires it already be running (e.g. solo-ui,
   * which programs its own Gateway on the shared GatewayClass).
   * @param {Array} addons
   * @returns {{ preGateway: Array, postGateway: Array }}
   */
  static splitByGatewayDependency(addons = []) {
    const preGateway = [];
    const postGateway = [];
    for (const addon of addons) {
      (FeatureManager.requiresGateway(addon.name) ? postGateway : preGateway).push(addon);
    }
    return { preGateway, postGateway };
  }

  static async installAddons(addons = []) {
    if (!addons || addons.length === 0) {
      Logger.info('No additional addons to install');
      return;
    }

    Logger.info(`Installing ${addons.length} additional addon(s)...`);
    const startTime = Date.now();

    for (const addon of addons) {
      await this.installAddon(addon);
    }

    Logger.success(`All addons installed successfully (${formatDuration(Date.now() - startTime)})`);
  }

  static async installAddon(addon) {
    const { name, description } = addon;
    const spinner = new SpinnerLogger();
    const startTime = Date.now();

    try {
      spinner.start(`Installing addon: ${name}...`);

      const featureExists = FeatureManager.has(name);

      if (!featureExists) {
        spinner.warn(`Addon '${name}' does not have a feature implementation, skipping`);
        return;
      }

      const mergedConfig = mergeAddonConfig(addon);
      const accessHint = await FeatureManager.deploy(name, mergedConfig, { spinner });

      const elapsed = formatDuration(Date.now() - startTime);
      spinner.succeed(
        `Addon '${name}' installed${description ? `: ${description}` : ''} (${elapsed})`
      );
      if (accessHint) {
        Logger.info(accessHint);
      }
    } catch (error) {
      const elapsed = formatDuration(Date.now() - startTime);
      spinner.fail(`Failed to install addon '${name}' after ${elapsed}: ${error.message}`);
      throw error;
    }
  }

  static async cleanupAddon(addon, { deleteNamespace = false } = {}) {
    const { name, namespace } = addon;
    const spinner = new SpinnerLogger();

    try {
      const featureExists = FeatureManager.has(name);

      if (!featureExists) {
        Logger.warn(`Addon '${name}' does not have a feature implementation, skipping cleanup`);
        return;
      }

      spinner.start(`Cleaning up addon: ${name}...`);
      await FeatureManager.cleanup(name, namespace ? { namespace, spinner } : { spinner });
      spinner.succeed(`Addon '${name}' cleaned up`);

      if (deleteNamespace && namespace) {
        if (PROTECTED_NAMESPACES.has(namespace)) {
          Logger.info(`Skipping deletion of shared/system namespace '${namespace}'`);
        } else {
          const nsResult = await KubernetesHelper.kubectl(
            ['get', 'namespace', namespace, '-o', 'name'],
            { ignoreError: true }
          );
          if (nsResult?.exitCode === 0 && nsResult?.stdout?.includes(namespace)) {
            Logger.info(`Deleting namespace ${namespace}...`);
            const deleteResult = await KubernetesHelper.kubectl(
              ['delete', 'namespace', namespace, '--wait=false'],
              { ignoreError: true }
            );
            if (deleteResult?.exitCode === 0) {
              Logger.success(`Namespace ${namespace} deletion initiated`);
            } else {
              Logger.warn(
                `Failed to delete namespace ${namespace}: ${deleteResult?.stderr || deleteResult?.message || 'unknown error'}`
              );
            }
          }
        }
      }
    } catch (error) {
      spinner.fail(`Failed to cleanup addon '${name}': ${error.message}`);
    }
  }

  static async cleanupAddons(addons = [], opts = {}) {
    if (!addons || addons.length === 0) {
      return;
    }

    Logger.info(`Cleaning up ${addons.length} addon(s)...`);

    for (const addon of addons) {
      await this.cleanupAddon(addon, opts);
    }
  }

  static async cleanupAllAddons({ deleteNamespace = false } = {}) {
    await this.cleanupAddons(PROFILE_ADDONS, { deleteNamespace });
    Logger.success('All addons cleaned up');
  }
}
