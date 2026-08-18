#!/usr/bin/env node

import { Command } from 'commander';
import { basename, join, resolve } from 'path';
import chalk from 'chalk';
import figlet from 'figlet';
import logSymbols from 'log-symbols';
import { Lok8sManager } from './lib/lok8s.js';
import { AgentGatewayManager } from './lib/agentgateway.js';
import { checkDependencies, Logger, KubernetesHelper, formatDuration } from './lib/common.js';
import { ProfileManager } from './lib/profiles.js';
import { UseCaseManager } from './lib/usecase.js';
import { AddonInstaller } from './lib/addons.js';
import { CLI_VERSION, CLI_DESCRIPTION } from './lib/version.js';
import { InfraManager } from './lib/infra-manager.js';
import { InfraStateManager } from './lib/infra-state.js';
import { Prompts } from './lib/prompts.js';
import { writeFile } from 'fs/promises';
import { RunbookBuilder, RunbookPicker } from './lib/runbook.js';
import { resolveEdition, EDITION_GATEWAY_NAME } from './lib/editions.js';
import { FeatureManager } from './lib/feature.js';

const program = new Command();

// Show banner
function showBanner() {
  const banner = figlet.textSync('Agentgateway', { font: 'Standard', horizontalLayout: 'default' });
  console.log(chalk.blue(banner));
  console.log(chalk.gray(`  Agentgateway Field Kit v${CLI_VERSION}\n`));
}

program
  .name('agw')
  .description(CLI_DESCRIPTION)
  .version(CLI_VERSION)
  .hook('preAction', () => {
    showBanner();
  });

program
  .command('version')
  .description('Display banner, version, and description')
  .option('-s, --short', 'Print only version and description (one per line) for scripts')
  .action(options => {
    if (options.short) {
      console.log(CLI_VERSION);
      console.log(CLI_DESCRIPTION);
      return;
    }
    console.log(chalk.gray('  Description: ') + chalk.white(CLI_DESCRIPTION));
    console.log(chalk.gray('  Version:     ') + chalk.white(CLI_VERSION));
    console.log(chalk.gray('  Node:        ') + chalk.white(process.version));
    console.log();
  });

// Base commands
const base = program.command('base').description('Manage base infrastructure');

// Infra commands
const infra = base.command('infra').description('Manage infrastructure');

// ============================================
// Local cluster subcommands (lok8s)
// ============================================
const local = infra.command('local').description('Manage local Kubernetes cluster (lok8s)');

local
  .command('install')
  .description('Install local Kubernetes cluster')
  .action(async () => {
    try {
      Logger.info('Installing local cluster...');
      await Lok8sManager.start();
      Logger.success('Local cluster installed successfully');
    } catch (error) {
      Logger.error('Failed to install local cluster');
      process.exit(1);
    }
  });

local
  .command('destroy')
  .description('Remove local Kubernetes cluster')
  .action(async () => {
    try {
      Logger.info('Destroying local cluster...');
      await Lok8sManager.delete();
      Logger.success('Local cluster removed successfully');
    } catch (error) {
      Logger.error('Failed to destroy local cluster');
      process.exit(1);
    }
  });

local
  .command('start')
  .description('Start local cluster')
  .action(async () => {
    try {
      await Lok8sManager.start();
    } catch (error) {
      Logger.error('Failed to start local cluster');
      process.exit(1);
    }
  });

local
  .command('stop')
  .description('Stop local cluster')
  .action(async () => {
    try {
      await Lok8sManager.stop();
    } catch (error) {
      Logger.error('Failed to stop local cluster');
      process.exit(1);
    }
  });

local
  .command('status')
  .description('Show local cluster and gateway status')
  .action(async () => {
    try {
      await Lok8sManager.status();
      console.log('');
      await AgentGatewayManager.status();
    } catch (error) {
      Logger.error('Failed to get status');
      process.exit(1);
    }
  });

// ============================================
// Cloud infrastructure subcommands
// ============================================

function printCloudInfraStatus(status, { kubeContext, matchedByContext } = {}) {
  if (kubeContext) {
    const matchLabel = matchedByContext ? chalk.green(' (matched)') : '';
    console.log(`\n${chalk.bold('Kubectl context:')} ${kubeContext}${matchLabel}`);
  }
  console.log(`${chalk.bold('Infra Profile:')} ${chalk.cyan(status.name)}`);
  console.log(`${chalk.bold('Provider:')} ${status.provider}`);
  console.log(`${chalk.bold('Defined clusters:')} ${status.defined}`);

  let phaseDisplay;
  switch (status.phase) {
    case 'provisioned':
      phaseDisplay = chalk.green('provisioned');
      break;
    case 'failed':
      phaseDisplay = chalk.red('failed');
      break;
    case 'provisioning':
      phaseDisplay = chalk.yellow('provisioning');
      break;
    case 'destroying':
      phaseDisplay = chalk.yellow('destroying');
      break;
    default:
      phaseDisplay = chalk.gray('not provisioned');
  }
  console.log(`${chalk.bold('Phase:')} ${phaseDisplay}`);

  if (status.error) {
    console.log(`${chalk.bold('Error:')} ${chalk.red(status.error)}`);
  }

  if (status.terraformStateExists && !status.provisioned) {
    console.log(
      `${chalk.bold('Terraform State:')} ${chalk.yellow('exists (partial resources may be provisioned)')}`
    );
  }

  if (status.needsCleanup && !status.provisioned) {
    console.log(
      `\n${chalk.yellow('⚠')}  Run ${chalk.cyan(`agw base infra cloud destroy -p ${status.name}`)} to clean up partial resources`
    );
  }

  if (status.updatedAt) {
    console.log(`${chalk.bold('Last updated:')} ${status.updatedAt}`);
  }

  if (status.clusters.length > 0) {
    console.log(`\n${chalk.bold('Clusters:')}`);
    for (const cluster of status.clusters) {
      console.log(`  ${chalk.bold(cluster.name)}`);
      if (cluster.cluster) {
        console.log(`    ${chalk.bold('Cluster:')}  ${cluster.cluster}`);
      }
      if (cluster.context && cluster.context !== kubeContext) {
        console.log(`    ${chalk.bold('Context:')}  ${cluster.context}`);
      }
      if (cluster.kubeconfig) {
        console.log(
          `    ${chalk.bold('Kubeconfig:')} ${InfraStateManager.formatProjectPath(cluster.kubeconfig)}`
        );
      } else if (!cluster.context) {
        console.log(`    ${chalk.yellow('not provisioned')}`);
      }
    }
  }

  if (status.dns?.enabled) {
    console.log(`\n${chalk.bold('DNS:')}`);
    console.log(`  ${chalk.bold('Zone:')} ${status.dns.zoneName}`);
    console.log(`  ${chalk.bold('Zone ID:')} ${status.dns.zoneId}`);
    if (status.dns.nameservers?.length > 0) {
      console.log(`  ${chalk.bold('Nameservers:')}`);
      status.dns.nameservers.forEach(ns => console.log(`    ${ns}`));
    }
  }

  if (status.provisioned) {
    const envSh = InfraStateManager.formatProjectPath(status.envShPath);
    console.log(`\n${chalk.bold('Env:')} source ${envSh}`);
  }
}

const cloud = infra.command('cloud').description('Manage cloud infrastructure');

cloud
  .command('list')
  .description('List available cloud infra profiles')
  .action(async () => {
    try {
      const profiles = await InfraManager.list();

      if (profiles.length === 0) {
        Logger.info('No infra profiles found in config/infra/');
        return;
      }

      console.log('\nAvailable cloud infra profiles:');
      for (const p of profiles) {
        let status;
        if (p.phase === 'provisioned' || p.provisioned) {
          status = chalk.green('provisioned');
        } else if (p.phase === 'failed') {
          status = chalk.red('failed');
        } else if (p.phase === 'provisioning') {
          status = chalk.yellow('provisioning');
        } else if (p.phase === 'destroying') {
          status = chalk.yellow('destroying');
        } else {
          status = chalk.gray('not provisioned');
        }

        // Add cleanup indicator
        const cleanupHint = p.needsCleanup && !p.provisioned ? chalk.red(' (needs cleanup)') : '';

        console.log(
          `  ${chalk.cyan(p.name.padEnd(18))} ${p.provider.padEnd(10)} ${String(p.clusterCount).padEnd(3)} cluster${p.clusterCount === 1 ? ' ' : 's'}  [${status}]${cleanupHint}`
        );
        if (p.error) {
          console.log(`  ${' '.repeat(18)} ${chalk.red('Error: ' + p.error.substring(0, 60))}...`);
        } else if (p.description) {
          console.log(`  ${' '.repeat(18)} ${chalk.gray(p.description)}`);
        }
      }
      console.log('');
    } catch (error) {
      Logger.error(`Failed to list infra profiles: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('provision')
  .description('Provision cloud infrastructure from an infra profile')
  .option('-p, --profile <name>', 'Infra profile name')
  .option('-y, --yes', 'Auto-approve provisioning without prompts')
  .action(async options => {
    try {
      let infraName = options.profile;

      if (!infraName) {
        const profiles = await InfraManager.list();
        if (profiles.length === 0) {
          Logger.error('No infra profiles found in config/infra/');
          process.exit(1);
        }
        const choices = profiles.map(p => ({
          name: `${p.name} (${p.provider}, ${p.clusterCount} cluster${p.clusterCount === 1 ? '' : 's'})`,
          value: p.name,
        }));
        infraName = await Prompts.select('Select an infra profile:', choices);
      }

      const manager = new InfraManager(infraName);
      await manager.provision({ autoApprove: options.yes });
      Logger.success(`Cloud infrastructure provisioned for: ${infraName}`);
    } catch (error) {
      Logger.error(`Failed to provision infrastructure: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('destroy')
  .description('Destroy provisioned cloud infrastructure')
  .option('-p, --profile <name>', 'Infra profile name')
  .option('-y, --yes', 'Auto-approve destruction without prompts')
  .action(async options => {
    try {
      let infraName = options.profile;

      if (!infraName) {
        // Try auto-detect: kubectl context match or sole provisioned profile
        infraName = await InfraStateManager.resolveInfraName(null);

        if (!infraName) {
          // Fall back to destroyable profiles (includes failed/needsCleanup)
          const profiles = await InfraManager.list();
          const destroyable = profiles.filter(p => p.provisioned || p.needsCleanup);
          if (destroyable.length === 0) {
            Logger.info('No provisioned cloud infrastructure found');
            return;
          }
          if (destroyable.length === 1) {
            infraName = destroyable[0].name;
            Logger.info(`Auto-detected infrastructure: ${infraName}`);
          } else {
            const choices = destroyable.map(p => {
              let suffix = `${p.provider}, ${p.clusterCount} cluster${p.clusterCount === 1 ? '' : 's'}`;
              if (p.phase === 'failed') {
                suffix += ', FAILED';
              }
              return {
                name: `${p.name} (${suffix})`,
                value: p.name,
              };
            });
            infraName = await Prompts.select('Select infrastructure to destroy:', choices);
          }
        }
      }

      if (!options.yes) {
        const confirmed = await Prompts.confirm(
          chalk.yellow('This will destroy all cloud infrastructure. Are you sure?'),
          false
        );
        if (!confirmed) {
          Logger.info('Destroy cancelled');
          return;
        }
      }

      const manager = new InfraManager(infraName);
      await manager.destroy({ autoApprove: true });
      Logger.success(`Cloud infrastructure destroyed for: ${infraName}`);
    } catch (error) {
      Logger.error(`Failed to destroy infrastructure: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('status')
  .description(
    'Show cloud infrastructure provisioning status (matches active kubectl context when possible)'
  )
  .option('-p, --profile <name>', 'Infra profile name')
  .action(async options => {
    try {
      const { targets, kubeContext, matchedByContext } =
        await InfraStateManager.resolveInfraStatusTargets(options.profile);

      if (targets.length === 0) {
        Logger.info('No cloud infrastructure state found');
        Logger.info('Provision with: agw base infra cloud provision');
        Logger.info('List profiles with: agw base infra cloud list');
        return;
      }

      for (let i = 0; i < targets.length; i++) {
        const manager = new InfraManager(targets[i]);
        const status = await manager.status();
        printCloudInfraStatus(status, {
          kubeContext,
          matchedByContext: matchedByContext && targets.length === 1,
        });
        if (i < targets.length - 1) {
          console.log(chalk.gray('─'.repeat(60)));
        }
      }

      console.log('');
    } catch (error) {
      Logger.error(`Failed to get status: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('env')
  .description('Print path to env.sh or its contents')
  .option('-p, --profile <name>', 'Infra profile name')
  .option('--print', 'Print env.sh contents to stdout instead of the path')
  .action(async options => {
    try {
      let infraName = options.profile;

      if (!infraName) {
        infraName = await InfraStateManager.resolveInfraName(null);
        if (!infraName) {
          const profiles = await InfraManager.list();
          const provisioned = profiles.filter(p => p.provisioned);
          if (provisioned.length === 0) {
            Logger.error('No provisioned cloud infrastructure found');
            process.exit(1);
          }
          const kubeContext = await InfraStateManager.getCurrentKubeContext();
          const prompt =
            kubeContext && provisioned.length > 1
              ? `Multiple provisioned infra profiles (kubectl context: ${kubeContext}). Select one:`
              : 'Select infrastructure:';
          const choices = provisioned.map(p => ({ name: p.name, value: p.name }));
          infraName = await Prompts.select(prompt, choices);
        }
      }

      const envShPath = InfraStateManager.getEnvShPath(infraName);
      const { existsSync } = await import('fs');

      if (!existsSync(envShPath)) {
        Logger.error(
          `No env.sh found for '${infraName}'. Run 'agw base cloud provision -p ${infraName}' first.`
        );
        process.exit(1);
      }

      if (options.print) {
        const { readFile } = await import('fs/promises');
        const content = await readFile(envShPath, 'utf8');
        process.stdout.write(content);
      } else {
        process.stdout.write(envShPath + '\n');
      }
    } catch (error) {
      Logger.error(`Failed to get env: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================
// Gateway commands (work with any cluster type)
// ============================================
base
  .command('clean-addons')
  .description('Clean up all profile-based addons')
  .action(async () => {
    try {
      await InfraStateManager.resolveAndApplyKubeContext();

      if (!(await KubernetesHelper.isClusterAccessible())) {
        Logger.error(
          'Cluster not accessible. Check your kubeconfig and credentials (e.g. aws sso login).'
        );
        process.exit(1);
      }

      const inquirer = (await import('inquirer')).default;
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: chalk.yellow('This will uninstall all addons. Are you sure?'),
          default: false,
        },
      ]);

      if (!answers.confirm) {
        Logger.info('Aborted');
        return;
      }

      Logger.info('Cleaning up all addons...');
      await AddonInstaller.cleanupAllAddons();
    } catch (error) {
      Logger.error('Failed to clean addons');
      if (error.message) Logger.error(error.message);
      process.exit(1);
    }
  });

base
  .command('install')
  .description('Install agentgateway enterprise with optional addons')
  .option('-p, --profile <name>', 'Installation profile name')
  .option('--infra <name>', 'Infra profile name (sets KUBECONFIG from provisioned state)')
  .option('--no-prompt', 'Skip interactive prompts and use defaults')
  .option('--skip-addons', 'Skip addon installation')
  .action(async options => {
    const startTime = Date.now();
    try {
      Logger.info('Installing agentgateway...');

      // Determine which profile to use
      let profileFile = null;
      let profileData = null;
      let profileName = null;

      if (options.profile) {
        profileFile = join(ProfileManager.PROFILES_DIR, `${options.profile}.yaml`);
        Logger.info(`Using profile: ${options.profile}`);
        try {
          profileData = await ProfileManager.load(profileFile);
          profileName = options.profile;
        } catch (error) {
          Logger.error(`Failed to load profile ${options.profile}: ${error.message}`);
          throw error;
        }
      } else if (options.prompt !== false) {
        try {
          const profile = await ProfileManager.select();
          Logger.info(`Selected profile: ${profile.name}`);
          profileFile = profile.file;
          profileData = await ProfileManager.load(profileFile);
          profileName = profile.name;
        } catch (error) {
          Logger.error(`Failed to select/load profile: ${error.message}`);
          throw error;
        }
      }

      const resolvedProfileEdition = resolveEdition(profileData?.edition);
      if (resolvedProfileEdition !== 'opensource') {
        AgentGatewayManager.checkLicenseKey();
      }

      // Addons (e.g. telemetry, solo-ui) target the Gateway by name in their own policy
      // YAML - set this before any addon installs so it resolves to the right edition's
      // Gateway object name, whether or not that addon runs before installProxy() creates it.
      FeatureManager.setGatewayRef({ name: EDITION_GATEWAY_NAME[resolvedProfileEdition] });

      // Resolve infra: explicit flag > profile binding > kubectl context > sole provisioned
      let resolvedInfra = options.infra || (profileData && profileData.infra) || null;

      if (resolvedInfra) {
        Logger.info(`Using infra '${resolvedInfra}' from ${options.infra ? 'flag' : 'profile'}`);
      } else {
        resolvedInfra = await InfraStateManager.resolveInfraName(null);
        if (!resolvedInfra) {
          const provisioned = (await InfraStateManager.listInfraProfiles()).filter(
            p => p.provisioned
          );
          if (provisioned.length > 1) {
            const kubeContext = await InfraStateManager.getCurrentKubeContext();
            const prompt = kubeContext
              ? `Multiple provisioned infra profiles (kubectl context: ${kubeContext}). Select one:`
              : 'Multiple provisioned infra profiles found. Select one:';
            const choices = provisioned.map(p => ({ name: p.name, value: p.name }));
            resolvedInfra = await Prompts.select(prompt, choices);
          }
        }
      }

      if (resolvedInfra) {
        const infraState = await InfraStateManager.load(resolvedInfra);
        if (!infraState?.status?.provisioned) {
          Logger.error(
            `Infra '${resolvedInfra}' is not provisioned. Run 'agw base cloud provision -p ${resolvedInfra}' first.`
          );
          process.exit(1);
        }
        await InfraStateManager.applyKubeContext(resolvedInfra, infraState);
      }

      await AgentGatewayManager.installCRDs(profileFile);

      const { preGateway, postGateway } = AddonInstaller.splitByGatewayDependency(
        profileData?.addons || []
      );

      if (!options.skipAddons && preGateway.length > 0) {
        Logger.info(`Installing ${preGateway.length} prerequisite addon(s) from profile...`);
        await AddonInstaller.installAddons(preGateway);
      }

      await AgentGatewayManager.install(profileFile);
      await AgentGatewayManager.installProxy(profileFile);

      if (!options.skipAddons && postGateway.length > 0) {
        Logger.info(`Installing ${postGateway.length} post-install addon(s) from profile...`);
        await AddonInstaller.installAddons(postGateway);
      }

      await AgentGatewayManager.recordInstallState({ profileName });

      Logger.success(
        `Gateway and all addons installed successfully in (${formatDuration(Date.now() - startTime)})`
      );
    } catch (error) {
      Logger.error('Failed to install gateway');
      if (error.message) {
        Logger.error(`Error: ${error.message}`);
      }
      if (error.stack && process.env.DEBUG) {
        Logger.debug(error.stack);
      }
      process.exit(1);
    }
  });

base
  .command('install-local')
  .description('Install everything (local cluster + gateway + addons)')
  .option('-p, --profile <name>', 'Installation profile name')
  .option('--infra <name>', 'Infra profile name (sets KUBECONFIG from provisioned state)')
  .option('--no-prompt', 'Skip interactive prompts and use defaults')
  .action(async options => {
    const startTime = Date.now();
    try {
      Logger.info('Installing complete stack...');

      // Install infrastructure first
      await Lok8sManager.start();

      // Determine which profile to use
      let profileFile = null;
      let profileData = null;
      let profileName = null;

      if (options.profile) {
        profileFile = join(ProfileManager.PROFILES_DIR, `${options.profile}.yaml`);
        Logger.info(`Using profile: ${options.profile}`);
        try {
          profileData = await ProfileManager.load(profileFile);
          profileName = options.profile;
        } catch (error) {
          Logger.error(`Failed to load profile ${options.profile}: ${error.message}`);
          throw error;
        }
      } else if (options.prompt !== false) {
        try {
          const profile = await ProfileManager.select();
          Logger.info(`Selected profile: ${profile.name}`);
          profileFile = profile.file;
          profileData = await ProfileManager.load(profileFile);
          profileName = profile.name;
        } catch (error) {
          Logger.error(`Failed to select/load profile: ${error.message}`);
          throw error;
        }
      }

      const resolvedProfileEdition = resolveEdition(profileData?.edition);
      if (resolvedProfileEdition !== 'opensource') {
        AgentGatewayManager.checkLicenseKey();
      }

      // Addons (e.g. telemetry, solo-ui) target the Gateway by name in their own policy
      // YAML - set this before any addon installs so it resolves to the right edition's
      // Gateway object name, whether or not that addon runs before installProxy() creates it.
      FeatureManager.setGatewayRef({ name: EDITION_GATEWAY_NAME[resolvedProfileEdition] });

      // Resolve infra: explicit flag > profile binding > kubectl context > sole provisioned
      let resolvedInfra = options.infra || (profileData && profileData.infra) || null;

      if (resolvedInfra) {
        Logger.info(`Using infra '${resolvedInfra}' from ${options.infra ? 'flag' : 'profile'}`);
      } else {
        resolvedInfra = await InfraStateManager.resolveInfraName(null);
        if (!resolvedInfra) {
          const provisioned = (await InfraStateManager.listInfraProfiles()).filter(
            p => p.provisioned
          );
          if (provisioned.length > 1) {
            const kubeContext = await InfraStateManager.getCurrentKubeContext();
            const prompt = kubeContext
              ? `Multiple provisioned infra profiles (kubectl context: ${kubeContext}). Select one:`
              : 'Multiple provisioned infra profiles found. Select one:';
            const choices = provisioned.map(p => ({ name: p.name, value: p.name }));
            resolvedInfra = await Prompts.select(prompt, choices);
          }
        }
      }

      if (resolvedInfra) {
        const infraState = await InfraStateManager.load(resolvedInfra);
        if (!infraState?.status?.provisioned) {
          Logger.error(
            `Infra '${resolvedInfra}' is not provisioned. Run 'agw base cloud provision -p ${resolvedInfra}' first.`
          );
          process.exit(1);
        }
        await InfraStateManager.applyKubeContext(resolvedInfra, infraState);
      }

      await AgentGatewayManager.installCRDs(profileFile);

      const { preGateway, postGateway } = AddonInstaller.splitByGatewayDependency(
        profileData?.addons || []
      );

      if (preGateway.length > 0) {
        Logger.info(`Installing ${preGateway.length} prerequisite addon(s) from profile...`);
        await AddonInstaller.installAddons(preGateway);
      }

      await AgentGatewayManager.install(profileFile);
      await AgentGatewayManager.installProxy(profileFile);

      if (postGateway.length > 0) {
        Logger.info(`Installing ${postGateway.length} post-install addon(s) from profile...`);
        await AddonInstaller.installAddons(postGateway);
      }

      await AgentGatewayManager.recordInstallState({ profileName });

      Logger.success(
        `Complete stack installed successfully (${formatDuration(Date.now() - startTime)})`
      );
    } catch (error) {
      Logger.error(
        `Failed to install complete stack after ${formatDuration(Date.now() - startTime)}`
      );
      process.exit(1);
    }
  });

base
  .command('clean')
  .description('Clean up agentgateway')
  .option('-a, --addons', 'Also remove profile-based addons and their namespaces')
  .option(
    '-p, --profile <name>',
    'Profile whose addons to remove (overrides tracked install state)'
  )
  .action(async options => {
    try {
      await InfraStateManager.resolveAndApplyKubeContext();

      if (!(await KubernetesHelper.isClusterAccessible())) {
        Logger.error(
          'Cluster not accessible. Check your kubeconfig and credentials (e.g. aws sso login).'
        );
        process.exit(1);
      }

      let profileName = null;
      let profileData = null;
      if (options.addons) {
        profileName = options.profile || (await AgentGatewayManager.getInstalledProfile());
        if (profileName) {
          try {
            profileData = await ProfileManager.load(
              join(ProfileManager.PROFILES_DIR, `${profileName}.yaml`)
            );
          } catch (error) {
            Logger.warn(
              `Could not load profile '${profileName}': ${error.message}. Falling back to full addon sweep.`
            );
            profileName = null;
          }
        } else {
          Logger.info('No tracked install profile found. Falling back to full addon sweep.');
        }
      }

      const inquirer = (await import('inquirer')).default;
      let msg = 'This will uninstall the gateway. Are you sure?';
      if (options.addons) {
        msg = profileName
          ? `This will uninstall the gateway and the addons from profile '${profileName}', and their namespaces. Are you sure?`
          : 'This will uninstall the gateway, all addons, and their namespaces. Are you sure?';
      }
      const answers = await inquirer.prompt([
        { type: 'confirm', name: 'confirm', message: chalk.yellow(msg), default: false },
      ]);

      if (!answers.confirm) {
        Logger.info('Cleanup cancelled');
        return;
      }

      if (options.addons) {
        if (profileName) {
          Logger.info(`Cleaning up addons from profile '${profileName}'...`);
          await AddonInstaller.cleanupAddons(profileData?.addons || [], { deleteNamespace: true });
        } else {
          Logger.info('Cleaning up all addons...');
          await AddonInstaller.cleanupAllAddons({ deleteNamespace: true });
        }
      }

      await AgentGatewayManager.uninstall({ deleteNamespace: options.addons });
      Logger.success('Cleanup completed');
    } catch (error) {
      Logger.error(`Failed to cleanup: ${error.message}`);
      process.exit(1);
    }
  });

// Feature commands
const feature = program.command('feature').description('Manage features');

feature
  .command('list')
  .description('List available features')
  .action(() => {
    Logger.info('Feature management coming soon...');
  });

// Profile commands
const profile = program.command('profile').description('Manage installation profiles');

profile
  .command('list')
  .description('List available installation profiles')
  .action(async () => {
    try {
      const profiles = await ProfileManager.list();

      console.log('\nAvailable profiles:');
      profiles.forEach(p => {
        console.log(ProfileManager.formatListEntry(p.name, p.description));
      });
      console.log('');
    } catch (error) {
      Logger.error('Failed to list profiles');
      process.exit(1);
    }
  });

// Use case commands
const usecase = program.command('usecase').description('Manage use cases');

usecase
  .command('list')
  .description('List available use cases')
  .action(async () => {
    try {
      const usecases = await UseCaseManager.list();

      // Group by edition, then by category
      const byEdition = {};
      usecases.forEach(u => {
        const edition = u.edition || 'enterprise';
        const category = u.category || 'root';
        byEdition[edition] = byEdition[edition] || {};
        byEdition[edition][category] = byEdition[edition][category] || [];
        byEdition[edition][category].push(u);
      });

      console.log('\nAvailable use cases:');
      Object.keys(byEdition)
        .sort()
        .forEach(edition => {
          console.log(`\n${chalk.bold.underline(edition.toUpperCase())}`);
          const byCategory = byEdition[edition];
          Object.keys(byCategory)
            .sort()
            .forEach(category => {
              const categoryName = category === 'root' ? 'General' : category.toUpperCase();
              console.log(`\n  ${chalk.bold(categoryName)}:`);
              byCategory[category]
                .sort((a, b) => a.name.localeCompare(b.name))
                .forEach(u => {
                  const name = u.category ? `${u.category}/${u.name}` : u.name;
                  const deprecatedTag = u.deprecated
                    ? chalk.yellow(
                        ` ${logSymbols.warning} [DEPRECATED → ${u.deprecated.replacedBy}]`
                      )
                    : '';
                  console.log(`    ${chalk.cyan('•')} ${name}${deprecatedTag}`);
                });
            });
        });
      console.log('');
    } catch (error) {
      Logger.error('Failed to list use cases');
      process.exit(1);
    }
  });

usecase
  .command('deploy')
  .description('Deploy a use case')
  .option('-n, --name <name>', 'Use case name')
  .option(
    '-e, --environment <name>',
    'Environment name for template resolution (e.g. local, aws-dev)'
  )
  .option('-y, --yes', 'Non-interactive: skip step-by-step prompts and run all steps automatically')
  .option('--no-diagrams', 'Hide ASCII flow diagrams during stepped deploy')
  .option('--no-test', 'Skip running use case tests after deploy')
  .action(async options => {
    try {
      if (!(await KubernetesHelper.isClusterAccessible())) {
        Logger.error('Cluster not accessible. Check your kubeconfig/context.');
        process.exit(1);
      }

      let usecaseName = null;

      if (options.name) {
        // Use case specified via command line
        usecaseName = options.name;
      } else {
        // Always prompt for use case selection unless --name provided
        const usecase = await UseCaseManager.select();
        usecaseName = usecase.name;
      }

      await UseCaseManager.deploy(usecaseName, {
        interactive: !options.yes,
        diagrams: options.diagrams !== false,
        test: options.test !== false,
        environment: options.environment,
      });
    } catch (error) {
      // UseCaseManager already logged the error with spinner.fail()
      process.exit(1);
    }
  });

usecase
  .command('dryrun')
  .description('Show generated YAML for a use case without applying (copy-friendly output)')
  .option('-n, --name <name>', 'Use case name')
  .option(
    '-e, --environment <name>',
    'Environment name for template resolution (e.g. local, aws-dev)'
  )
  .option('-o, --output <file>', 'Write generated YAML to a file instead of stdout')
  .option('--no-prompt', 'Skip interactive prompts')
  .action(async options => {
    try {
      let usecaseName = null;

      if (options.name) {
        usecaseName = options.name;
      } else if (options.prompt !== false) {
        const usecase = await UseCaseManager.select();
        usecaseName = usecase.name;
      } else {
        Logger.error('Please specify a use case with --name or run without --no-prompt');
        process.exit(1);
      }

      await UseCaseManager.dryRun(usecaseName, {
        environment: options.environment,
        output: options.output,
      });
    } catch (error) {
      Logger.error(error.message);
      process.exit(1);
    }
  });

usecase
  .command('test')
  .description('Test a deployed use case')
  .option('-n, --name <name>', 'Use case name')
  .option('-c, --cleanup', 'Run cleanup after tests complete (undeploys features)')
  .option('--no-prompt', 'Skip interactive prompts')
  .action(async options => {
    try {
      if (!(await KubernetesHelper.isClusterAccessible())) {
        Logger.error('Cluster not accessible. Check your kubeconfig/context.');
        process.exit(1);
      }

      let usecaseName = null;

      if (options.name) {
        // Use case specified via command line
        usecaseName = options.name;
      } else if (options.prompt !== false) {
        // Interactive mode - prompt user to select use case
        const usecase = await UseCaseManager.select();
        usecaseName = usecase.name;
      } else {
        Logger.error('Please specify a use case with --name or run without --no-prompt');
        process.exit(1);
      }

      await UseCaseManager.test(usecaseName, { cleanup: options.cleanup });
    } catch (error) {
      // UseCaseManager already logged the error
      process.exit(1);
    }
  });

usecase
  .command('clean')
  .description('Clean up a deployed use case')
  .option('-n, --name <name>', 'Use case name')
  .option('-c, --current', 'Use currently deployed use case (auto-detect from cluster)')
  .option('--no-prompt', 'Skip interactive prompts')
  .action(async options => {
    try {
      await InfraStateManager.resolveAndApplyKubeContext();

      if (!(await KubernetesHelper.isClusterAccessible())) {
        Logger.error('Cluster not accessible. Check your kubeconfig/context.');
        process.exit(1);
      }

      let usecaseName = null;

      if (options.name) {
        usecaseName = options.name;
      } else if (options.current) {
        const currentUseCase = await UseCaseManager.getCurrentUseCase();
        if (currentUseCase) {
          usecaseName = currentUseCase;
          Logger.info(`Detected deployed use case: ${basename(currentUseCase, '.yaml')}`);
        } else {
          Logger.error('No use case currently deployed');
          process.exit(1);
        }
      } else if (options.prompt !== false) {
        const usecase = await UseCaseManager.select();
        usecaseName = usecase.name;
      } else {
        Logger.error(
          'Please specify a use case with --name or --current, or run without --no-prompt'
        );
        process.exit(1);
      }

      await UseCaseManager.cleanup(usecaseName);
    } catch (error) {
      // UseCaseManager already logged the error with spinner.fail()
      process.exit(1);
    }
  });

usecase
  .command('generate-diagrams')
  .description('Generate spec.diagram (Mermaid) for all use case YAML files')
  .action(async () => {
    try {
      const { updated, skipped, errors } = await UseCaseManager.generateDiagramsForAll();
      if (errors.length > 0) {
        errors.forEach(({ file, error }) => Logger.error(`${file}: ${error}`));
        process.exit(1);
      }
      console.log(chalk.green(`Updated ${updated.length} use case(s) with spec.diagram`));
      updated.forEach(f => console.log(chalk.gray('  ') + f));
      if (skipped.length > 0) {
        console.log(chalk.gray(`Skipped ${skipped.length} (no steps or no features)`));
      }
    } catch (error) {
      Logger.error(error.message);
      process.exit(1);
    }
  });

// ============================================
// Runbook commands
// ============================================
const runbook = program.command('runbook').description('Generate runbook documentation');

runbook
  .command('generate')
  .description('Interactively generate a runbook runbook markdown file')
  .option('-o, --output <file>', 'Output file path', './runbook.md')
  .option('-t, --title <title>', 'Runbook title (skips title prompt)')
  .action(async options => {
    try {
      const selection = await RunbookPicker.prompt();
      if (options.title) selection.title = options.title;

      Logger.info('Generating runbook document...');
      const builder = new RunbookBuilder(selection);
      const markdown = await builder.build();

      const outputPath = resolve(options.output);
      await writeFile(outputPath, markdown, 'utf8');

      Logger.success(`Runbook document written to: ${outputPath}`);
      Logger.info(
        `Labs included: ${1 + (selection.providers.length > 0 ? 1 : 0) + selection.labs.length}`
      );
    } catch (error) {
      Logger.error(`Failed to generate runbook: ${error.message}`);
      process.exit(1);
    }
  });

// Utility commands
program
  .command('check-deps')
  .description('Check if required dependencies are installed')
  .action(async () => {
    const allInstalled = await checkDependencies();
    if (!allInstalled) {
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);

// Show help if no arguments
if (process.argv.length === 2) {
  program.help();
}
