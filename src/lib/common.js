import chalk from 'chalk';
import { execa } from 'execa';
import { spawn } from 'child_process';
import ora from 'ora';
import logSymbols from 'log-symbols';
import stringWidth from 'string-width';

/**
 * Common utilities for the agentgateway field kit
 */

export class Logger {
  static info(message) {
    console.log(chalk.blue(logSymbols.info), message);
  }

  static success(message) {
    console.log(chalk.green(logSymbols.success), message);
  }

  static warn(message) {
    console.log(chalk.yellow(logSymbols.warning), message);
  }

  static error(message) {
    console.error(chalk.red(logSymbols.error), message);
  }

  static debug(message) {
    if (process.env.DEBUG === 'true') {
      console.log(chalk.gray(logSymbols.info), message);
    }
  }
}

/**
 * SpinnerLogger - Manages ora spinner with logging
 * Properly handles spinner state when logging messages
 */
export class SpinnerLogger {
  constructor(initialText = '') {
    this.spinner = ora(initialText);
    this.isSpinning = false;
  }

  start(text) {
    this.spinner.text = text;
    this.spinner.start();
    this.isSpinning = true;
    return this;
  }

  stop() {
    if (this.isSpinning) {
      this.spinner.stop();
      this.isSpinning = false;
    }
    return this;
  }

  succeed(message) {
    this.spinner.succeed(message);
    this.isSpinning = false;
    return this;
  }

  fail(message) {
    this.spinner.fail(message);
    this.isSpinning = false;
    return this;
  }

  warn(message) {
    this.spinner.warn(message);
    this.isSpinning = false;
    return this;
  }

  info(message) {
    this.spinner.info(message);
    this.isSpinning = false;
    return this;
  }

  setText(text) {
    this.spinner.text = text;
    return this;
  }

  /**
   * Safely log a message while spinner is running
   * Clears spinner, logs message, then re-renders spinner
   * Note: 'info' level messages are suppressed to avoid cluttering output
   */
  logWhileSpinning(message, level = 'info') {
    // Suppress info-level messages during spinner operation
    if (level === 'info') {
      return this;
    }

    if (this.isSpinning) {
      this.spinner.clear();
      this.spinner.frame();
    }

    switch (level) {
      case 'success':
        Logger.success(message);
        break;
      case 'warn':
        Logger.warn(message);
        break;
      case 'error':
        Logger.error(message);
        break;
      case 'debug':
        Logger.debug(message);
        break;
    }

    if (this.isSpinning) {
      this.spinner.render();
    }

    return this;
  }

  /**
   * Safely output to console while spinner is running
   * Use this instead of console.log when a spinner is active
   */
  consoleLog(...args) {
    if (this.isSpinning) {
      this.spinner.clear();
      console.log(...args);
      this.spinner.render();
    } else {
      console.log(...args);
    }
    return this;
  }

  /**
   * Clear the spinner (useful before other console output)
   */
  clear() {
    if (this.isSpinning) {
      this.spinner.clear();
    }
    return this;
  }

  /**
   * Re-render the spinner (useful after console output)
   */
  render() {
    if (this.isSpinning) {
      this.spinner.render();
    }
    return this;
  }
}

/** Known error patterns that map to actionable hints. */
const ERROR_HINTS = [
  {
    pattern:
      /Token has expired and refresh failed|executable aws failed with exit code 255|getting credentials: exec:/i,
    hint: 'AWS credentials expired — run: aws sso login',
  },
  {
    pattern: /Unable to locate credentials|NoCredentialProviders|no EC2 IMDS role found/i,
    hint: 'AWS credentials not configured — run: aws configure or aws sso login',
  },
  {
    pattern: /x509: certificate signed by unknown authority/i,
    hint: 'TLS certificate error — cluster CA may not be trusted',
  },
  {
    pattern: /Unable to connect to the server.*dial tcp/i,
    hint: 'Cannot reach Kubernetes API server — check kubeconfig context and VPN',
  },
];

/** Patterns for secret-bearing CLI args that must never reach logs/error output in cleartext. */
const SECRET_PATTERNS = [/(licensing\.licenseKey=)[^'"\s]+/gi];

function redactSecrets(text) {
  if (!text) return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '$1***REDACTED***');
  }
  return redacted;
}

function redactErrorSecrets(error) {
  if (error.message) error.message = redactSecrets(error.message);
  if (error.shortMessage) error.shortMessage = redactSecrets(error.shortMessage);
  if (error.stdout) error.stdout = redactSecrets(error.stdout);
  if (error.stderr) error.stderr = redactSecrets(error.stderr);
  if (Array.isArray(error.stdio)) {
    error.stdio = error.stdio.map(part => (typeof part === 'string' ? redactSecrets(part) : part));
  }
  return error;
}

function enrichError(error) {
  const text = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n');
  for (const { pattern, hint } of ERROR_HINTS) {
    if (pattern.test(text)) {
      const enriched = new Error(hint);
      enriched.cause = error;
      return enriched;
    }
  }
  return error;
}

export class CommandRunner {
  static async run(command, args = [], options = {}) {
    const { verbose = false, cwd = process.cwd() } = options;

    if (verbose) {
      Logger.debug(`Running: ${redactSecrets(`${command} ${args.join(' ')}`)}`);
    }

    try {
      const result = await execa(command, args, {
        cwd,
        ...options,
      });
      return result;
    } catch (error) {
      redactErrorSecrets(error);
      if (!options.ignoreError) {
        throw enrichError(error);
      }
      return error;
    }
  }

  static async exec(command, options = {}) {
    return this.run('bash', ['-c', command], options);
  }

  static async execStream(command, lineHandler, options = {}) {
    const { cwd = process.cwd(), env, ignoreError = false } = options;

    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const onSigInt = () => {
        child.kill('SIGINT');
        setTimeout(() => process.exit(130), 500);
      };
      const onSigTerm = () => {
        child.kill('SIGTERM');
        setTimeout(() => process.exit(143), 500);
      };
      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);

      const pipeLines = stream => {
        let buffer = '';
        stream.on('data', chunk => {
          try {
            buffer += chunk.toString();
            let idx;
            while ((idx = buffer.search(/[\n\r]/)) !== -1) {
              const line = buffer.slice(0, idx);
              const sep = buffer[idx];
              buffer = buffer.slice(idx + 1);
              if (sep === '\r' && buffer[0] === '\n') buffer = buffer.slice(1);
              if (line.length > 0) lineHandler(line);
            }
          } catch (err) {
            Logger.error(`Stream handler error: ${err.message}`);
          }
        });
        stream.on('end', () => {
          try {
            if (buffer.length > 0) {
              lineHandler(buffer);
              buffer = '';
            }
          } catch (err) {
            Logger.error(`Stream end handler error: ${err.message}`);
          }
        });
      };

      pipeLines(child.stdout);
      pipeLines(child.stderr);

      child.on('error', err => {
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
        if (!ignoreError) reject(err);
        else resolve({ exitCode: 1 });
      });

      child.on('close', code => {
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
        if (code !== 0 && !ignoreError) {
          reject(new Error(`Command failed with exit code ${code}: ${redactSecrets(command)}`));
        } else {
          resolve({ exitCode: code });
        }
      });
    });
  }
}

export class KubernetesHelper {
  static _defaultContext = null;

  static setDefaultContext(context) {
    this._defaultContext = context || null;
  }

  static async kubectl(args, options = {}) {
    const ctxArgs = this._defaultContext ? [`--context=${this._defaultContext}`] : [];
    return CommandRunner.run('kubectl', [...ctxArgs, ...args], options);
  }

  static async helm(args, options = {}) {
    const ctxArgs = this._defaultContext ? [`--kube-context=${this._defaultContext}`] : [];
    return CommandRunner.run('helm', [...ctxArgs, ...args], options);
  }

  static async waitForDeployment(namespace, deploymentName, timeout = 300, externalSpinner = null) {
    // Use external spinner if provided, otherwise create new one
    const spinner = externalSpinner || new SpinnerLogger();
    const ownSpinner = !externalSpinner;

    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    // First, wait for the deployment to exist
    if (ownSpinner) {
      spinner.start('Waiting for deployment to be created...');
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await this.kubectl(['get', 'deployment', deploymentName, '-n', namespace], {
          ignoreError: true,
          spinner,
        });

        if (result.exitCode === 0) {
          break;
        }
      } catch {
        // Deployment doesn't exist yet, continue waiting
      }

      // Wait 2 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if we've timed out
      if (Date.now() - startTime >= timeoutMs) {
        if (ownSpinner) {
          spinner.fail(`Timeout waiting for deployment ${deploymentName} to be created`);
        }
        throw new Error(`Deployment ${deploymentName} was not created within ${timeout}s`);
      }
    }

    // Now wait for the deployment to become available
    if (ownSpinner) {
      spinner.setText('Waiting for deployment to be ready...');
    }

    try {
      const remainingTimeout = Math.max(
        10,
        Math.floor((timeoutMs - (Date.now() - startTime)) / 1000)
      );

      await this.kubectl(
        [
          'wait',
          '--for=condition=available',
          `deployment/${deploymentName}`,
          '-n',
          namespace,
          `--timeout=${remainingTimeout}s`,
        ],
        { spinner }
      );

      if (ownSpinner) {
        spinner.succeed('Deployment is ready');
      }
      return true;
    } catch (error) {
      if (ownSpinner) {
        spinner.fail('Deployment failed to become ready');
      }
      throw error;
    }
  }

  static async cleanupAndWaitForDeployment(
    namespace,
    deploymentName,
    labelSelector,
    timeout = 300
  ) {
    try {
      await this.kubectl(
        [
          'delete',
          'pod',
          '-l',
          labelSelector,
          '-n',
          namespace,
          '--field-selector=status.phase!=Running,status.phase!=Pending',
        ],
        { ignoreError: true }
      );
    } catch {
      // Ignore - no failed pods to delete
    }

    await this.kubectl([
      'rollout',
      'status',
      `deployment/${deploymentName}`,
      '-n',
      namespace,
      `--timeout=${timeout}s`,
    ]);
  }

  static async ensureNamespace(namespace, spinner = null) {
    const result = await this.kubectl(['get', 'namespace', namespace], { ignoreError: true });
    const exists = result.exitCode === 0;
    if (exists) {
      if (!spinner) {
        Logger.info(`Namespace ${namespace} already exists`);
      }
      return;
    }
    // Namespace does not exist — create it
    if (!spinner) {
      Logger.info(`Creating namespace ${namespace}...`);
    }
    await this.kubectl(['create', 'namespace', namespace]);
    if (!spinner) {
      Logger.success(`Namespace ${namespace} created`);
    }
  }

  /**
   * Check if a Kubernetes resource exists
   * @param {string} resourceType - Resource type (e.g., 'secret', 'deployment')
   * @param {string} name - Resource name
   * @param {string} namespace - Namespace (optional)
   * @returns {Promise<boolean>} True if resource exists
   */
  static async resourceExists(resourceType, name, namespace = null) {
    try {
      const args = ['get', resourceType, name];
      if (namespace) {
        args.push('-n', namespace);
      }
      args.push('--ignore-not-found=true', '-o', 'name');

      const result = await this.kubectl(args, { ignoreError: true });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  static async createSecretFromLiteral(
    namespace,
    secretName,
    key,
    value,
    _spinner = null,
    labels = {}
  ) {
    const result = await this.kubectl([
      'create',
      'secret',
      'generic',
      secretName,
      `--from-literal=${key}=${value}`,
      '-n',
      namespace,
      '--dry-run=client',
      '-o',
      'yaml',
    ]);
    await this.kubectl(['apply', '-f', '-'], {
      input: result.stdout,
    });

    const labelEntries = Object.entries(labels);
    if (labelEntries.length > 0) {
      await this.kubectl([
        'label',
        'secret',
        secretName,
        '-n',
        namespace,
        ...labelEntries.map(([k, v]) => `${k}=${v}`),
        '--overwrite',
      ]);
    }
  }

  static async applyYaml(yamlContent, _spinner = null) {
    await this.kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], {
      input: yamlContent,
    });
  }

  static async getLoadBalancerAddress(namespace, serviceName, timeout = 300) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout * 1000) {
      try {
        const result = await this.kubectl(
          [
            'get',
            'svc',
            serviceName,
            '-n',
            namespace,
            '-o',
            'jsonpath={.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}',
          ],
          { ignoreError: true }
        );

        const address = result.stdout.trim();
        if (address) {
          return address;
        }
      } catch {
        // Continue waiting
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error('Timeout waiting for LoadBalancer address');
  }

  /**
   * Check whether the current (or given) kube context can reach the API server.
   * Bounds both kubectl's own request and the child process itself, so an unreachable
   * API server (dead VPN, stale kubeconfig, dropped packets) fails fast instead of hanging
   * indefinitely with no output.
   */
  static async isClusterAccessible(contextFlag = '') {
    const args = contextFlag
      ? [contextFlag, 'cluster-info', '--request-timeout=10s']
      : ['cluster-info', '--request-timeout=10s'];
    const spinner = new SpinnerLogger().start('Checking cluster accessibility...');
    const result = await this.kubectl(args, { ignoreError: true, timeout: 15000 });
    const accessible = result?.exitCode === 0;
    if (accessible) {
      spinner.stop();
    } else {
      spinner.fail('Cluster is not accessible');
    }
    return accessible;
  }
}

/**
 * LocalDnsHelper - Manages /etc/hosts entries for local development
 *
 * Only manipulates /etc/hosts for local hostnames (*.local, *.svc.cluster.local, etc.)
 * Real FQDNs are expected to use external-dns or proper DNS.
 */
export class LocalDnsHelper {
  /**
   * Check if a hostname is a local/internal hostname that needs /etc/hosts
   */
  static isLocalHostname(hostname) {
    return (
      hostname.endsWith('.local') ||
      hostname.endsWith('.svc') ||
      hostname.endsWith('.svc.cluster.local') ||
      hostname.includes('.cluster.local') ||
      hostname === 'localhost' ||
      hostname.startsWith('127.') ||
      !hostname.includes('.')
    );
  }

  /**
   * Add a hostname -> IP mapping to /etc/hosts if needed
   * @param {string} hostname - The hostname to add
   * @param {string} address - The IP or CNAME to map to
   * @param {Object} options - Options
   * @param {SpinnerLogger} options.spinner - Spinner to pause during sudo prompt
   * @param {string} options.featureName - Feature name for spinner resume text
   * @returns {Promise<{added: boolean, skipped: boolean, message: string}>}
   */
  static async ensureHostsEntry(hostname, address, options = {}) {
    const { spinner = null, featureName = '' } = options;

    // Skip for real FQDNs - external-dns handles these
    if (!this.isLocalHostname(hostname)) {
      return {
        added: false,
        skipped: true,
        message: `Using external DNS for ${hostname}, skipping /etc/hosts setup`,
      };
    }

    if (!address) {
      return {
        added: false,
        skipped: true,
        message: 'No address provided, skipping /etc/hosts setup',
      };
    }

    const hostsEntry = `${address} ${hostname}`;

    try {
      // Check if entry already exists
      const check = await CommandRunner.exec(
        `grep -q "${hostname}" /etc/hosts 2>/dev/null && echo exists || echo missing`,
        { ignoreError: true }
      );

      if (check.stdout.trim() === 'exists') {
        return {
          added: false,
          skipped: true,
          message: `/etc/hosts already contains ${hostname}`,
        };
      }

      // Check if sudo is available without password
      const sudoCheck = await CommandRunner.exec('sudo -n true 2>/dev/null', {
        ignoreError: true,
      });

      if (sudoCheck.exitCode !== 0) {
        // Pause spinner and clearly request sudo
        if (spinner) spinner.stop();
        console.log('\n🔐 Updating /etc/hosts requires sudo access.');
        console.log(`   Adding: ${hostsEntry}\n`);
      }

      await CommandRunner.exec(`echo '${hostsEntry}' | sudo tee -a /etc/hosts > /dev/null`);

      // Resume spinner if we stopped it
      if (sudoCheck.exitCode !== 0 && spinner) {
        spinner.start(featureName ? `Deploying: ${featureName}...` : 'Continuing...');
      }

      return {
        added: true,
        skipped: false,
        message: `/etc/hosts: ${hostname} -> ${address}`,
      };
    } catch {
      // Resume spinner if stopped
      if (spinner && !spinner.isSpinning) {
        spinner.start(featureName ? `Deploying: ${featureName}...` : 'Continuing...');
      }

      return {
        added: false,
        skipped: false,
        message: `Could not update /etc/hosts. Run manually:\n  echo '${hostsEntry}' | sudo tee -a /etc/hosts`,
        error: true,
      };
    }
  }

  /**
   * Remove a hostname from /etc/hosts
   * @param {string} hostname - The hostname to remove
   * @returns {Promise<{removed: boolean, message: string}>}
   */
  static async removeHostsEntry(hostname) {
    if (!this.isLocalHostname(hostname)) {
      return { removed: false, message: 'Not a local hostname, nothing to remove' };
    }

    try {
      const sudoCheck = await CommandRunner.exec('sudo -n true 2>/dev/null', {
        ignoreError: true,
      });

      if (sudoCheck.exitCode !== 0) {
        return {
          removed: false,
          message: `Removing ${hostname} from /etc/hosts requires sudo. Run manually:\n  sudo sed -i '' '/${hostname}/d' /etc/hosts`,
        };
      }

      await CommandRunner.exec(`sudo sed -i '' '/${hostname}/d' /etc/hosts`, {
        ignoreError: true,
      });

      return { removed: true, message: `Removed ${hostname} from /etc/hosts` };
    } catch (error) {
      return { removed: false, message: `Could not remove from /etc/hosts: ${error.message}` };
    }
  }
}

/**
 * CertificateHelper - Manages TLS certificates via cert-manager
 *
 * Automatically selects the appropriate issuer based on hostname:
 * - Let's Encrypt (DNS-01) for external FQDNs
 * - Self-signed for local/internal hostnames
 */
export class CertificateHelper {
  /**
   * Check if hostname is an external FQDN (should use Let's Encrypt)
   */
  static isExternalHostname(hostname) {
    return !LocalDnsHelper.isLocalHostname(hostname);
  }

  /**
   * Get the appropriate ClusterIssuer name for a hostname
   * @param {string} hostname - The hostname
   * @returns {string} ClusterIssuer name ('letsencrypt-dns' or 'selfsigned-issuer')
   */
  static getIssuerName(hostname) {
    return this.isExternalHostname(hostname) ? 'letsencrypt-dns' : 'selfsigned-issuer';
  }

  /**
   * Create a cert-manager Certificate resource spec
   * @param {Object} options - Certificate options
   * @param {string} options.name - Certificate/secret name
   * @param {string} options.namespace - Namespace
   * @param {string} options.hostname - Primary hostname (commonName)
   * @param {string[]} [options.additionalDnsNames] - Additional DNS names
   * @param {string} [options.issuerName] - Override issuer name (auto-detected if not provided)
   * @param {string} [options.issuerKind] - Issuer kind (default: 'ClusterIssuer')
   * @returns {Object} Certificate resource
   */
  static createCertificate(options) {
    const {
      name,
      namespace,
      hostname,
      additionalDnsNames = [],
      issuerName = this.getIssuerName(hostname),
      issuerKind = 'ClusterIssuer',
    } = options;

    const dnsNames = [hostname, ...additionalDnsNames];

    return {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name,
        namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentgateway-demo' },
      },
      spec: {
        secretName: name,
        issuerRef: {
          name: issuerName,
          kind: issuerKind,
        },
        commonName: hostname,
        dnsNames,
      },
    };
  }

  /**
   * Wait for a certificate to be ready
   * @param {string} namespace - Certificate namespace
   * @param {string} name - Certificate name
   * @param {number} [timeoutSeconds=120] - Timeout in seconds
   * @param {SpinnerLogger} [spinner] - Optional spinner for logging
   * @returns {Promise<boolean>} True if ready, false if timeout
   */
  static async waitForCertificate(namespace, name, timeoutSeconds = 120, _spinner = null) {
    const maxAttempts = Math.ceil(timeoutSeconds / 2);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await KubernetesHelper.kubectl([
          'get',
          'certificate',
          name,
          '-n',
          namespace,
          '-o',
          'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
        ]);

        if (result?.stdout?.trim() === 'True') {
          return true;
        }
      } catch {
        // Certificate may not exist yet
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    return false;
  }
}

export async function checkDependencies() {
  const required = ['kubectl', 'helm', 'docker', 'jq', 'yq'];
  const missing = [];

  Logger.info('Checking dependencies...');

  for (const cmd of required) {
    try {
      await CommandRunner.run('command', ['-v', cmd], { ignoreError: true });
      console.log(chalk.green('✓'), cmd);
    } catch {
      console.log(chalk.yellow('✗'), cmd, chalk.gray('(missing)'));
      missing.push(cmd);
    }
  }

  if (missing.length > 0) {
    Logger.error(`Missing required dependencies: ${missing.join(', ')}`);
    Logger.info('Please install missing dependencies before continuing.');
    return false;
  }

  Logger.success('All dependencies are installed');
  return true;
}

/**
 * BoxedOutput - Renders child process output inside a Unicode box frame.
 *
 * Usage:
 *   const box = new BoxedOutput('terraform init');
 *   box.open();
 *   box.writeLine('Initializing the backend...');
 *   box.close();
 */
export class BoxedOutput {
  // eslint-disable-next-line no-control-regex
  static ANSI_RE = /\x1b\[[0-9;]*m/g;

  constructor(title = '', { indent = 2, minWidth = 60 } = {}) {
    this.title = title;
    this.indent = indent;
    this.minWidth = minWidth;
    this.lastLineCount = 0;
    this.lastWasProgress = false;
  }

  get boxWidth() {
    const cols = process.stdout.columns || 80;
    return Math.max(this.minWidth, cols - this.indent * 2);
  }

  get innerWidth() {
    return this.boxWidth - 4;
  }

  static stripAnsi(str) {
    return str.replace(BoxedOutput.ANSI_RE, '');
  }

  static visibleLength(str) {
    return BoxedOutput.stripAnsi(str).length;
  }

  pad() {
    return ' '.repeat(this.indent);
  }

  open() {
    const w = this.boxWidth;
    const border = chalk.gray;
    let top;
    if (this.title) {
      const label = ` ${this.title} `;
      const remaining = Math.max(0, w - 2 - label.length - 1);
      top = border('┌─') + chalk.bold(label) + border('─'.repeat(remaining) + '┐');
    } else {
      top = border('┌' + '─'.repeat(w - 2) + '┐');
    }
    console.log('');
    console.log(this.pad() + top);
  }

  formatBoxLine(line) {
    const border = chalk.gray;
    const prefix = this.pad() + border('│') + ' ';
    const suffix = ' ' + border('│');
    const maxW = this.innerWidth;
    const visible = BoxedOutput.visibleLength(line);
    const padding = Math.max(0, maxW - visible);
    return prefix + line + ' '.repeat(padding) + suffix;
  }

  writeLine(rawLine) {
    const maxW = this.innerWidth;
    const lines = this.wrapLine(rawLine, maxW);
    for (const line of lines) {
      process.stdout.write(this.formatBoxLine(line) + '\n');
    }
    this.lastLineCount = lines.length;
    this.lastWasProgress = false;
  }

  writeProgress(rawLine) {
    const maxW = this.innerWidth;
    const lines = this.wrapLine(rawLine, maxW);
    const output = lines.map(l => this.formatBoxLine(l)).join('\n');

    if (this.lastWasProgress && this.lastLineCount > 0) {
      process.stdout.write(`\x1b[${this.lastLineCount}A\x1b[0J`);
    }

    process.stdout.write(output + '\n');
    this.lastLineCount = lines.length;
    this.lastWasProgress = true;
  }

  wrapLine(line, maxW) {
    const stripped = BoxedOutput.stripAnsi(line);
    if (stripped.length <= maxW) {
      return [line];
    }

    const results = [];
    let remaining = line;

    while (BoxedOutput.visibleLength(remaining) > maxW) {
      const target = results.length === 0 ? maxW : maxW - 2;
      let cutAt = this.findWrapPoint(remaining, target);
      const segment = remaining.slice(0, cutAt);
      remaining = remaining.slice(cutAt);

      if (remaining.length > 0 && remaining[0] === ' ') {
        remaining = remaining.slice(1);
      }

      results.push(segment);
      if (remaining.length > 0) {
        remaining = '  ' + remaining;
      }
    }

    if (remaining.length > 0) {
      results.push(remaining);
    }

    return results;
  }

  findWrapPoint(str, targetVisible) {
    let visible = 0;
    let inEscape = false;
    let lastSpace = -1;
    let lastSpaceVisible = -1;

    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\x1b') {
        inEscape = true;
        continue;
      }
      if (inEscape) {
        if (str[i] === 'm') inEscape = false;
        continue;
      }
      if (str[i] === ' ') {
        lastSpace = i;
        lastSpaceVisible = visible;
      }
      visible++;
      if (visible >= targetVisible) {
        if (lastSpace > 0 && lastSpaceVisible >= targetVisible * 0.2) {
          return lastSpace;
        }
        return i + 1;
      }
    }
    return str.length;
  }

  close() {
    const w = this.boxWidth;
    const border = chalk.gray;
    console.log(this.pad() + border('└' + '─'.repeat(w - 2) + '┘'));
    console.log('');
  }
}

export function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the AWS Load Balancer Controller annotation set for a public-facing NLB.
 * Always pins the scheme to internet-facing — AWS LBC's own default is `internal`
 * (private VPC IPs only), silently unreachable from outside the VPC; confirmed live
 * more than once as the cause of a "stuck"/timed-out install with no clear error.
 * Additionally gates the listener to a fixed CIDR allowlist (e.g. a VPN egress range)
 * when sourceRanges is non-empty.
 *
 * Two non-obvious AWS LBC gotchas, both confirmed live in the sibling agentic-field-kit
 * repo (source-ranges silently had no effect, NLB stayed open to 0.0.0.0/0, until both
 * were fixed):
 *  - The CIDR-allowlist key is `load-balancer-source-ranges` with NO `aws-` prefix —
 *    the one annotation in this whole system inherited from the generic in-tree
 *    cloud-provider convention rather than AWS LBC's own `aws-load-balancer-*` naming.
 *  - With nlb-target-type=ip, AWS disables client-IP preservation by default, and
 *    source-ranges is documented to be ignored entirely when that's disabled — so it
 *    must be turned back on via target-group-attributes.
 *
 * .flat() is defensive rather than load-bearing here: EnvironmentManager's template
 * resolver always returns plain strings (String.replace() coerces any value to a
 * string), so sourceRanges never actually contains a nested array the way it can in
 * the sibling repos' full-value-token resolver — but flattening is harmless either way.
 */
export function nlbSourceRangeAnnotations(sourceRanges) {
  const ranges = (Array.isArray(sourceRanges) ? sourceRanges : [sourceRanges])
    .flat()
    .filter(Boolean);
  return {
    'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
    'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
    'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
    'service.beta.kubernetes.io/aws-load-balancer-target-group-attributes':
      'preserve_client_ip.enabled=true',
    ...(ranges.length > 0
      ? { 'service.beta.kubernetes.io/load-balancer-source-ranges': ranges.join(',') }
      : {}),
  };
}

/**
 * Wait indefinitely for a public hostname to resolve in DNS, then verify HTTP reachability.
 *
 * Phase 1 — DNS: polls dns.lookup(hostname) every `interval` ms until an IP is returned. Uses
 * dns.lookup() (getaddrinfo, the OS resolver) rather than dns.resolve4() (a raw query against
 * /etc/resolv.conf's nameserver) so this respects the same resolution path — split-DNS overrides
 * (e.g. macOS /etc/resolver/*), /etc/hosts, nsswitch.conf — that Phase 2's HTTP request below
 * already goes through. The two phases used to disagree: Phase 1 could hang on a stale answer
 * from a caching resolver (e.g. Pi-hole) that Phase 2 would have already bypassed.
 * Phase 2 — HTTP: polls the URL (ignoring TLS cert errors) until a non-5xx response is received.
 * Phase 3 — TLS (HTTPS only): verifies TLS cert is valid (trusted) before returning.
 *
 * @param {string} hostname
 * @param {object} [options]
 * @param {string}   options.protocol  - 'https' (default) or 'http'
 * @param {number}   options.port      - TCP port (default: 443 for https, 80 for http)
 * @param {string}   options.path      - URL path to probe (default: '/')
 * @param {number}   options.interval  - polling interval in ms (default: 10000)
 * @param {object}   options.spinner   - SpinnerLogger instance for status text updates
 * @param {Function} options.log       - log(message, level) function; falls back to Logger
 */
export async function waitForPublicUrl(
  hostname,
  {
    protocol = 'https',
    port = null,
    path = '/',
    interval = 10_000,
    spinner = null,
    log = null,
  } = {}
) {
  const { promises: dns } = await import('dns');
  const lib = await import(protocol === 'https' ? 'https' : 'http');

  const logger = log || ((msg, level = 'info') => Logger[level]?.(msg) ?? Logger.info(msg));
  const startTime = Date.now();

  const elapsed = () => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  };

  // ── Phase 1: DNS resolution ────────────────────────────────────────────────
  logger(`Waiting for DNS to resolve: ${hostname}`, 'info');
  while (true) {
    try {
      const { address } = await dns.lookup(hostname, { family: 4 });
      logger(`DNS resolved: ${hostname} → ${address} (${elapsed()})`, 'success');
      break;
    } catch {
      // ENOTFOUND or similar — record not propagated yet
    }
    if (spinner) spinner.setText(`Waiting for DNS: ${hostname} (${elapsed()})`);
    await waitFor(interval);
  }

  // ── Phase 2: HTTP reachability (TLS-insecure) ─────────────────────────────
  const url = `${protocol}://${hostname}${path}`;
  logger(`Waiting for URL to be reachable: ${url}`, 'info');
  const resolvedPort = port ?? (protocol === 'https' ? 443 : 80);

  while (true) {
    const reachable = await new Promise(resolve => {
      const req = lib.request(
        {
          hostname,
          port: resolvedPort,
          path,
          method: 'GET',
          rejectUnauthorized: false,
          timeout: 8_000,
        },
        res => {
          res.resume();
          resolve(res.statusCode < 500);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });

    if (reachable) break;
    if (spinner) spinner.setText(`Waiting for URL: ${url} (${elapsed()})`);
    await waitFor(interval);
  }

  // ── Phase 3 (HTTPS only): TLS-verified ────────────────────────────────────
  if (protocol === 'https') {
    logger(`Waiting for valid TLS on: ${url}`, 'info');
    while (true) {
      const tlsOk = await new Promise(resolve => {
        const req = lib.request(
          {
            hostname,
            port: resolvedPort,
            path,
            method: 'GET',
            rejectUnauthorized: true,
            timeout: 8_000,
          },
          res => {
            res.resume();
            resolve(res.statusCode < 500);
          }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });

      if (tlsOk) {
        logger(`URL reachable with valid TLS: ${url} (${elapsed()})`, 'success');
        return;
      }
      if (spinner) spinner.setText(`Waiting for valid TLS: ${hostname} (${elapsed()})`);
      await waitFor(interval);
    }
  }

  logger(`URL reachable: ${url} (${elapsed()})`, 'success');
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} e.g. "2m 34s", "45s", "320ms"
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Wrap text to a given terminal width, preserving an optional leading indent
 * on every line. Uses `string-width` so ANSI escape codes are excluded from
 * the measured length.
 *
 * @param {string} text       - Text to wrap (whitespace is normalised)
 * @param {number} [width]    - Max line width (defaults to terminal width, capped at 120)
 * @param {string} [indent]   - String prepended to every output line (default: '')
 * @returns {string}
 */
export function wrapText(text, width = Math.min(process.stdout.columns || 100, 120), indent = '') {
  const maxContent = width - stringWidth(indent);
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (stringWidth(candidate) > maxContent && line) {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) lines.push(indent + line);
  return lines.join('\n');
}

/**
 * Format a multi-line description preserving structure (bullets, numbered lists, paragraphs).
 * @param {string} text - The description text
 * @param {string} [indent='  '] - Indentation for each line
 * @returns {string} Formatted description
 */
export function formatDescription(text, indent = '  ') {
  if (!text) return '';
  const width = Math.min(process.stdout.columns || 100, 100);
  const lines = text.split('\n');
  const result = [];

  // pending: { type: 'para'|'list', content: string }
  let pending = null;

  const flush = () => {
    if (!pending) return;
    if (result.length > 0) result.push('');
    if (pending.type === 'list') {
      const bulletMatch = pending.content.match(/^([-*])\s+/);
      const numberedMatch = pending.content.match(/^(\(\d+\)\s*|\d+[.)]\s*)/);
      const isBullet = !!bulletMatch;
      const prefix = isBullet ? indent + '• ' : indent + numberedMatch[0].trimEnd() + ' ';
      const lineIndent = ' '.repeat(prefix.length);
      const markerLen = isBullet ? bulletMatch[0].length : numberedMatch[0].length;
      const content = pending.content.slice(markerLen).trim();
      const wrapped = wrapText(content, width - prefix.length, '');
      const wrappedLines = wrapped.split('\n');
      result.push(prefix + wrappedLines[0]);
      for (let i = 1; i < wrappedLines.length; i++) {
        result.push(lineIndent + wrappedLines[i]);
      }
    } else {
      result.push(wrapText(pending.content, width, indent));
    }
    pending = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const hasContinuationIndent = /^\s/.test(line);
    const isListItem =
      /^[-*]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed) || /^\(\d+\)\s/.test(trimmed);

    if (isListItem) {
      flush();
      pending = { type: 'list', content: trimmed };
    } else if (hasContinuationIndent && pending?.type === 'list') {
      // Indented continuation line — append to current list item
      pending.content += ' ' + trimmed;
    } else {
      // Regular paragraph — flush immediately (each > folded line is one unit)
      flush();
      pending = { type: 'para', content: trimmed };
      flush();
    }
  }
  flush();
  return result.join('\n');
}

/**
 * Print a bordered box showing raw HTTP request and response details.
 * @param {{ method: string, url: string, headers: Object, body: any }} request
 * @param {{ status: number, headers: Object, body: any }} response
 */
export function printTrafficBox(request, response) {
  const BOX_WIDTH = Math.min(process.stdout.columns || 100, 100);
  const INNER = BOX_WIDTH - 2;
  const CONTENT_MAX = INNER - 2;

  const DIM = chalk.dim;

  const padVisual = (str, width) => {
    const w = stringWidth(str);
    return w >= width ? str : str + ' '.repeat(width - w);
  };

  const top = DIM('┌' + '─'.repeat(INNER) + '┐');
  const bottom = DIM('└' + '─'.repeat(INNER) + '┘');
  const mid = DIM('├' + '─'.repeat(INNER) + '┤');

  const row = (text = '') => {
    const safe = String(text).replace(/\r?\n/g, ' ');
    const visLen = stringWidth(safe);
    let content = safe;
    if (visLen > CONTENT_MAX) {
      // eslint-disable-next-line no-control-regex
      const stripped = safe.replace(/\x1B\[[0-9;]*m/g, '');
      content = stripped.substring(0, CONTENT_MAX - 1) + '…';
    }
    return DIM('│') + ' ' + padVisual(content, CONTENT_MAX) + ' ' + DIM('│');
  };

  const sectionRow = (label, colorFn) => {
    const colored = colorFn(' ' + label);
    return DIM('│') + padVisual(colored, INNER) + DIM('│');
  };

  const maskSensitive = (key, value) => {
    const k = key.toLowerCase();
    if (['authorization', 'x-ai-api-key', 'x-api-key', 'cookie'].includes(k)) {
      const s = String(value);
      return s.length > 20 ? s.substring(0, 12) + '…[masked]' : s;
    }
    return value;
  };

  const formatBodyLines = (body, maxLines = 30) => {
    if (body == null || body === '') return ['(empty)'];
    let str;
    if (typeof body === 'object') {
      try {
        str = JSON.stringify(body, null, 2);
      } catch {
        str = String(body);
      }
    } else {
      str = String(body);
    }
    const lines = str.split('\n');
    return lines.length > maxLines
      ? [...lines.slice(0, maxLines), chalk.dim(`… (${lines.length - maxLines} more lines)`)]
      : lines;
  };

  const out = ['', top];

  out.push(sectionRow('REQUEST', chalk.bold.cyan));
  out.push(row());
  out.push(row(`  ${chalk.bold(request.method)}  ${request.url}`));

  if (request.headers && Object.keys(request.headers).length > 0) {
    out.push(row());
    out.push(row(chalk.dim('  Headers')));
    for (const [k, v] of Object.entries(request.headers)) {
      out.push(row(`    ${chalk.dim(k + ':')} ${maskSensitive(k, v)}`));
    }
  }

  if (request.body != null) {
    out.push(row());
    out.push(row(chalk.dim('  Body')));
    for (const l of formatBodyLines(request.body)) {
      out.push(row('    ' + l));
    }
  }

  out.push(mid);

  out.push(sectionRow('RESPONSE', chalk.bold.magenta));
  out.push(row());

  const statusFn =
    response.status >= 200 && response.status < 300
      ? chalk.green
      : response.status >= 400
        ? chalk.red
        : chalk.yellow;
  out.push(row('  ' + chalk.dim('Status:') + ' ' + statusFn(String(response.status))));

  if (response.headers && Object.keys(response.headers).length > 0) {
    out.push(row());
    out.push(row(chalk.dim('  Headers')));
    for (const [k, v] of Object.entries(response.headers)) {
      out.push(row(`    ${chalk.dim(k + ':')} ${v}`));
    }
  }

  if (response.body != null) {
    out.push(row());
    out.push(row(chalk.dim('  Body')));
    for (const l of formatBodyLines(response.body)) {
      out.push(row('    ' + l));
    }
  }

  out.push(bottom, '');
  console.log(out.join('\n'));
}
