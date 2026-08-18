import { spawn } from 'child_process';
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import chalk from 'chalk';
import {
  Logger,
  SpinnerLogger,
  KubernetesHelper,
  CommandRunner,
  printTrafficBox,
  wrapText,
} from './common.js';
import { resolveEdition, EDITION_GATEWAY_NAME } from './editions.js';

/**
 * Use case test runner
 * Handles test execution for agentgateway use cases
 */
export class UseCaseTestRunner {
  /**
   * Run tests for a use case
   * @param {Object} usecase - Parsed use case object with metadata and spec
   * @returns {Promise<void>}
   */
  static async runTests(usecase) {
    const spinner = new SpinnerLogger();
    const { metadata, spec } = usecase;

    try {
      Logger.info(`Testing use case: ${metadata.name}`);

      if (!spec.tests || spec.tests.length === 0) {
        Logger.warn(`No tests defined for use case '${metadata.name}'`);
        return;
      }

      const testLine =
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
      console.log('');
      console.log(chalk.cyan(chalk.bold(testLine)));
      console.log(chalk.cyan(chalk.bold(`  🧪 Running Tests -> (${spec.tests.length} test(s))`)));
      console.log(chalk.cyan(chalk.bold(testLine)));
      console.log('');

      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const total = spec.tests.length;

      for (let i = 0; i < spec.tests.length; i++) {
        const test = spec.tests[i];
        const testName = test.name || 'unnamed-test';
        const testDesc = test.description || 'No description';
        const idx = `[${i + 1}/${total}]`;
        const headerLabel = `  ${idx} ${testName} `;
        const headerFill = '─'.repeat(Math.max(0, testLine.length - headerLabel.length));

        console.log(chalk.dim(`${headerLabel}${headerFill}`));

        spinner.start(`Running test: ${testName}`);

        try {
          if (!test.steps || test.steps.length === 0) {
            spinner.warn(`Test '${testName}' has no steps - skipped`);
            skipped++;
            console.log('');
            continue;
          }

          if (test.setup && test.setup.length > 0) {
            spinner.setText(`Running setup for: ${testName}`);
            await this.executeTestSteps(
              { ...test, steps: test.setup },
              metadata.name,
              spec,
              spinner
            );
          }

          try {
            await this.executeTestSteps(test, metadata.name, spec, spinner);
          } finally {
            if (test.teardown && test.teardown.length > 0) {
              spinner.setText(`Running teardown for: ${testName}`);
              await this.executeTestSteps(
                { ...test, steps: test.teardown },
                metadata.name,
                spec,
                spinner
              );
            }
          }

          spinner.succeed(testName);
          if (testDesc && testDesc !== 'No description') {
            console.log(wrapText(testDesc, undefined, '  '));
          }
          passed++;
        } catch (error) {
          if (error.skipped) {
            spinner.warn(`${testName}: ${error.message} - skipped`);
            skipped++;
          } else {
            spinner.fail(`${testName}: ${error.message}`);
            failed++;
          }
        }

        console.log('');
      }

      const summaryColor = failed > 0 ? chalk.red : chalk.green;
      const skippedPart = skipped > 0 ? chalk.yellow(` · ${skipped} skipped`) : '';
      console.log(summaryColor(chalk.bold(testLine)));
      console.log(
        summaryColor(chalk.bold(`  Results: ${passed} passed · ${failed} failed${skippedPart}`))
      );
      console.log(summaryColor(chalk.bold(testLine)));
      console.log('');

      if (failed > 0) {
        throw new Error(`${failed} test(s) failed`);
      }
    } catch (error) {
      if (error.message.includes('test(s) failed')) {
        throw error;
      }
      spinner.fail(`Failed to run tests: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute test steps
   * @param {Object} test - Test definition
   * @param {string} usecaseName - Use case name
   * @param {Object} spec - Use case spec
   * @param {SpinnerLogger} spinner - Spinner logger
   * @returns {Promise<void>}
   */
  static async executeTestSteps(test, usecaseName, spec, spinner) {
    const { namespace } = spec;
    const gatewayNamespace =
      namespace || process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system';

    // Usecases can declare features either flat (spec.features) or nested under steps
    // (spec.steps[].features) - check both so a stepped usecase's gateway override
    // (e.g. existing: true pointing at a non-default Gateway) is actually picked up.
    const stepFeatures = (spec.steps || []).flatMap(s => s.features || []);
    const gatewayFeature =
      (spec.features || []).find(f => f.name === 'gateway') ||
      stepFeatures.find(f => f.name === 'gateway');
    const gatewayName =
      gatewayFeature?.config?.name || EDITION_GATEWAY_NAME[resolveEdition(spec.edition)];
    const gatewayPort = gatewayFeature?.config?.listeners?.[0]?.port || 8080;

    const parseTimeoutSecs = (val, fallbackSecs = 30) => {
      if (val == null) return fallbackSecs;
      if (typeof val === 'number') return val;
      const s = String(val).trim();
      if (s.endsWith('ms')) return Math.ceil(parseFloat(s) / 1000);
      if (s.endsWith('m')) return parseFloat(s) * 60;
      if (s.endsWith('s')) return parseFloat(s);
      const n = parseFloat(s);
      return isNaN(n) ? fallbackSecs : n;
    };

    const defaultTimeout = spec.timeout || 30000;
    const testTimeout = test.timeout || defaultTimeout;

    let lastResponse = null;
    let lastResponseBody = null;
    let lastResponseStatus = null;
    let bearerToken = null;
    let actorToken = null;
    let sessionCookie = null;
    let apiKey = null;
    let apiKeyHeader = null;
    let registeredClient = null;

    for (const step of test.steps) {
      const action = step.action;

      switch (action) {
        case 'register-client': {
          const prevText = spinner.spinner.text;
          spinner.setText('Registering MCP client via dynamic client registration...');
          if (step.discoveryUrl) {
            // Fully-qualified discovery URL - e.g. eager-auth-okta's controller-hosted
            // issuer lives on the profile's public HTTPS listener (a different
            // scheme/host/port than the gateway's own LB address), so there's no
            // gateway address to resolve.
            registeredClient = await this.registerClientViaDiscovery(null, null, step);
          } else if (step.discoveryEndpoint) {
            const dcrGateway = await this.getGatewayAddress(gatewayNamespace, gatewayName);
            if (!dcrGateway)
              throw new Error('Gateway address not found - ensure gateway is deployed');
            registeredClient = await this.registerClientViaDiscovery(dcrGateway, gatewayPort, step);
          } else {
            registeredClient = await this.registerClient(step);
          }
          spinner.stop();
          Logger.success(`Dynamically registered client '${registeredClient.clientId}'`);
          spinner.start(prevText);
          break;
        }

        case 'get-token': {
          const prevText = spinner.spinner.text;
          if (step.entra) {
            if (step.entra.discoveryUrl) {
              spinner.stop();
              Logger.info('Opening browser for Entra login...');
              bearerToken = await this.getTokenViaBrowserEntra(step);
              Logger.success('Token obtained via browser login (real Entra JWT)');
              spinner.start(prevText);
              break;
            }
            spinner.setText('Obtaining token via Entra client_credentials grant...');
            bearerToken = await this.getTokenViaEntraClientCredentials(step);
            spinner.stop();
            Logger.success('Token obtained via Entra client_credentials grant');
            spinner.start(prevText);
            break;
          }
          if (step.okta) {
            spinner.stop();
            Logger.info('Opening browser for Okta login...');
            bearerToken = await this.getTokenViaBrowserOkta(step);
            Logger.success('Token obtained via browser login (real Okta JWT)');
            spinner.start(prevText);
            break;
          }
          if (step.auth0) {
            spinner.stop();
            Logger.info('Registering a client via DCR and opening browser for Auth0 login...');
            bearerToken = await this.getTokenViaBrowserAuth0(step);
            Logger.success('Token obtained via browser login (real Auth0 JWT)');
            spinner.start(prevText);
            break;
          }
          const kc = step.keycloak || {};
          if (kc.grantType === 'password' || kc.grantType === 'client_credentials') {
            spinner.setText('Obtaining token via password grant...');
            bearerToken = await this.getTokenViaPasswordGrant(step, registeredClient);
            spinner.stop();
            Logger.success('Token obtained via password grant');
            spinner.start(prevText);
          } else {
            spinner.stop();
            Logger.info('Opening browser for Keycloak login...');
            bearerToken = await this.getTokenViaBrowser(step);
            Logger.success('Token obtained via browser login');
            spinner.start(prevText);
          }
          break;
        }

        case 'get-session-cookie': {
          const gw = await this.getGatewayAddress(gatewayNamespace, gatewayName);
          if (!gw) throw new Error('Gateway address not found');
          const prevText = spinner.spinner.text;
          spinner.stop();
          sessionCookie = await this.getSessionCookie(gw, gatewayPort, step);
          Logger.info('Session cookie obtained');
          spinner.start(prevText);
          break;
        }

        case 'get-apikey': {
          const secretName = step.secretName || 'apikey';
          const secretNs = step.namespace || gatewayNamespace;
          const secretKey = step.secretKey || 'api-key';
          apiKeyHeader = step.headerName || 'x-ai-api-key';

          spinner.setText(`Reading API key from secret ${secretNs}/${secretName}...`);
          const result = await KubernetesHelper.kubectl([
            'get',
            'secret',
            secretName,
            '-n',
            secretNs,
            '-o',
            `jsonpath={.data.${secretKey.replace(/\./g, '\\.')}}`,
          ]);
          const b64 = (result.stdout || '').trim();
          if (!b64) {
            throw new Error(
              `API key not found in secret ${secretNs}/${secretName} key=${secretKey}`
            );
          }
          apiKey = Buffer.from(b64, 'base64').toString('utf8');
          spinner.setText('API key retrieved from secret');
          break;
        }

        case 'get-k8s-token': {
          const sa = step.serviceAccount || 'default';
          const ns = step.namespace || gatewayNamespace;
          const duration = step.duration || '1h';
          const role = step.role || 'actor';
          spinner.setText(`Creating K8s SA token for ${ns}/${sa} (${role})...`);
          const ktResult = await KubernetesHelper.kubectl([
            'create',
            'token',
            sa,
            '-n',
            ns,
            '--duration',
            duration,
          ]);
          const k8sToken = (ktResult.stdout || '').trim();
          if (!k8sToken)
            throw new Error('get-k8s-token: kubectl create token returned empty output');
          if (role === 'subject') {
            bearerToken = k8sToken;
          } else {
            actorToken = k8sToken;
          }
          spinner.setText(`K8s SA token created for ${ns}/${sa} (${role})`);
          break;
        }

        case 'exchange-sts-token': {
          const stsConf = step.sts || {};
          const stsService = stsConf.service || 'enterprise-agentgateway';
          const stsNs = stsConf.namespace || 'agentgateway-system';
          const stsPort = stsConf.port || 7777;
          const localPort = stsConf.localPort || 17777;

          spinner.setText(
            `Port-forwarding ${stsNs}/${stsService}:${stsPort} → localhost:${localPort}...`
          );
          const pfProc = spawn(
            'kubectl',
            ['port-forward', '-n', stsNs, `svc/${stsService}`, `${localPort}:${stsPort}`],
            { stdio: 'pipe' }
          );

          await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('exchange-sts-token: port-forward timed out')),
              10000
            );
            pfProc.stdout.on('data', data => {
              if (data.toString().includes('Forwarding from')) {
                clearTimeout(timer);
                resolve();
              }
            });
            pfProc.on('error', err => {
              clearTimeout(timer);
              reject(err);
            });
            pfProc.on('close', code => {
              if (code !== null) {
                clearTimeout(timer);
                reject(new Error(`port-forward exited with code ${code}`));
              }
            });
          });

          try {
            if (!bearerToken)
              throw new Error(
                'exchange-sts-token: no subject token — run get-token or get-k8s-token first'
              );

            const params = {
              grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
              subject_token: bearerToken,
              subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            };
            if (actorToken) {
              params.actor_token = actorToken;
              params.actor_token_type = 'urn:ietf:params:oauth:token-type:jwt';
            }
            const tokenBody = new URLSearchParams(params).toString();

            const curlArgs = [
              '-s',
              '--max-time',
              '10',
              '-X',
              'POST',
              `http://localhost:${localPort}/oauth2/token`,
              '-H',
              'Content-Type: application/x-www-form-urlencoded',
              '-H',
              `Authorization: Bearer ${bearerToken}`,
              '-d',
              tokenBody,
              '-w',
              '\n%{http_code}',
            ];

            spinner.setText('Exchanging token with AGW STS...');
            const stsResult = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

            const raw = (stsResult.stdout || '').trim();
            const lines = raw.split('\n');
            const httpStatus = parseInt(lines[lines.length - 1], 10);
            const stsBody = lines.slice(0, -1).join('\n').trim();

            Logger.debug(`STS /token status: ${httpStatus}, body: ${stsBody || '(empty)'}`);

            if (httpStatus !== 200) {
              const detail = stsBody || stsResult.stderr || '(no response body)';
              throw new Error(`exchange-sts-token: STS returned HTTP ${httpStatus}: ${detail}`);
            }
            if (!stsBody) throw new Error('exchange-sts-token: STS returned 200 with empty body');

            let parsed;
            try {
              parsed = JSON.parse(stsBody);
            } catch (e) {
              throw new Error(`exchange-sts-token: failed to parse STS response: ${e.message}`);
            }
            if (!parsed.access_token)
              throw new Error('exchange-sts-token: STS response missing access_token');

            bearerToken = parsed.access_token;
            spinner.setText('Token exchanged successfully');
          } finally {
            pfProc.kill();
          }
          break;
        }

        case 'call-agent': {
          // agent/message fall back to endpoint/query (a gateway-route-style shorthand some
          // usecases use, e.g. endpoint: /caller-agent, query: '...') for callers that don't
          // set agent/message explicitly.
          const agentName =
            step.agent || (step.endpoint ? step.endpoint.replace(/^\//, '') : 'caller-agent');
          const agentNs = step.namespace || gatewayNamespace;
          const agentPort = step.port || 8080;
          const localPort = step.localPort || 28080;
          const message = step.message || step.prompt || step.query || 'Hello';
          const threadId = step.threadId || 'test-thread';
          // ADK agents built in this repo (caller-agent, loan-agent, fd-agent, stock-agent)
          // only expose POST /run with a {query} body - confirmed via their OpenAPI schema.
          // sidecar-agent images expose POST /chat with {message, thread_id} instead (default,
          // preserved for routing/sidecar-agents.yaml's existing agent/message-style steps).
          const path = step.path || '/chat';

          spinner.setText(`Calling agent ${agentNs}/${agentName}...`);
          const pfProc = spawn(
            'kubectl',
            ['port-forward', '-n', agentNs, `svc/${agentName}`, `${localPort}:${agentPort}`],
            { stdio: 'pipe' }
          );

          await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('call-agent: port-forward timed out')),
              10000
            );
            pfProc.stdout.on('data', data => {
              if (data.toString().includes('Forwarding from')) {
                clearTimeout(timer);
                resolve();
              }
            });
            pfProc.on('error', err => {
              clearTimeout(timer);
              reject(err);
            });
            pfProc.on('close', code => {
              if (code !== null) {
                clearTimeout(timer);
                reject(new Error(`port-forward exited with code ${code}`));
              }
            });
          });

          try {
            const payload = JSON.stringify(
              path === '/run' ? { query: message } : { message, thread_id: threadId }
            );

            const headers = ['Content-Type: application/json'];
            if (bearerToken) {
              headers.push(`Authorization: Bearer ${bearerToken}`);
            }

            const curlArgs = [
              '-s',
              '--max-time',
              String(parseTimeoutSecs(step.timeout || testTimeout)),
              '-X',
              'POST',
              `http://localhost:${localPort}${path}`,
              ...headers.flatMap(h => ['-H', h]),
              '-d',
              payload,
              '-w',
              '\n%{http_code}',
            ];

            spinner.setText(`Sending message to ${agentName}...`);
            const agentResult = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

            const raw = (agentResult.stdout || '').trim();
            const lines = raw.split('\n');
            const httpStatus = parseInt(lines[lines.length - 1], 10);
            const agentBody = lines.slice(0, -1).join('\n').trim();

            lastResponseStatus = httpStatus;
            lastResponseBody = agentBody;
            lastResponse = { status: httpStatus, body: agentBody };

            if (step.showTraffic || test.showTraffic) {
              const prevText = spinner.spinner.text;
              spinner.stop();
              printTrafficBox(
                {
                  method: 'POST',
                  url: `http://${agentName}${path}`,
                  headers: Object.fromEntries(headers.map(h => h.split(': '))),
                  body: payload,
                },
                { status: httpStatus, body: agentBody }
              );
              spinner.start(prevText);
            }

            spinner.setText(`Agent response received, status: ${httpStatus}`);
          } finally {
            pfProc.kill();
          }
          break;
        }

        case 'send-request': {
          const stepGatewayNamespace = step.gatewayNamespace || gatewayNamespace;
          const stepGatewayName = step.gatewayName || gatewayName;
          const gateway = await this.getGatewayAddress(stepGatewayNamespace, stepGatewayName);
          if (!gateway) {
            throw new Error('Gateway address not found - ensure gateway is deployed');
          }

          if (step.headers) {
            step.headers = this.substituteEnvVarsInHeaders(step.headers);
          }
          if (step.auth === 'bearer' && bearerToken) {
            step.headers = { ...step.headers, Authorization: `Bearer ${bearerToken}` };
          } else if (step.auth === 'session' && sessionCookie) {
            step.headers = { ...step.headers, Cookie: sessionCookie };
          }
          if (apiKey && apiKeyHeader) {
            step.headers = { ...step.headers, [apiKeyHeader]: apiKey };
          }

          spinner.setText(`Sending request to ${gateway}...`);

          try {
            const stepTimeout = step.timeout || testTimeout;
            const maxRetries = step.retries ?? 0;
            const retryDelay = step.retryDelay ?? 3000;
            let result;

            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
              result = await this.sendHttpRequest(gateway, step, spinner, stepTimeout, gatewayPort);
              if (result.status < 500 || attempt > maxRetries) break;
              spinner.setText(
                `Request returned ${result.status}, retrying in ${retryDelay / 1000}s (${attempt}/${maxRetries})...`
              );
              await new Promise(r => setTimeout(r, retryDelay));
            }

            lastResponse = {
              ...result.response,
              headers: result.responseHeaders,
              connectionFailed: result.connectionFailed,
              connectionError: result.connectionError,
            };
            lastResponseBody = result.body;
            lastResponseStatus = result.status;

            if (step.showTraffic || test.showTraffic) {
              const prevText = spinner.spinner.text;
              spinner.stop();
              printTrafficBox(result.requestInfo, {
                status: result.status,
                headers: result.responseHeaders,
                body: result.body,
              });
              spinner.start(prevText);
            }

            spinner.setText(
              result.connectionFailed
                ? `Request sent, connection failed: ${result.connectionError}`
                : `Request sent, status: ${lastResponseStatus}`
            );
          } catch (error) {
            throw new Error(`Request failed: ${error.message}`);
          }
          break;
        }

        case 'send-tts-request': {
          const gateway = await this.getGatewayAddress(gatewayNamespace, gatewayName);
          if (!gateway) {
            throw new Error('Gateway address not found - ensure gateway is deployed');
          }

          spinner.setText(`Sending TTS request to ${gateway}...`);

          try {
            const stepTimeout = step.timeout || testTimeout;
            const result = await this.sendTtsRequest(
              gateway,
              step,
              spinner,
              stepTimeout,
              gatewayPort
            );

            lastResponse = { headers: result.responseHeaders };
            lastResponseBody = result.body;
            lastResponseStatus = result.status;
            spinner.setText(`TTS request sent, status: ${lastResponseStatus}`);
          } catch (error) {
            throw new Error(`TTS request failed: ${error.message}`);
          }
          break;
        }

        case 'send-audio-file-request': {
          const gateway = await this.getGatewayAddress(gatewayNamespace, gatewayName);
          if (!gateway) {
            throw new Error('Gateway address not found - ensure gateway is deployed');
          }

          spinner.setText(`Sending audio file request to ${gateway}...`);

          try {
            const stepTimeout = step.timeout || testTimeout;
            const result = await this.sendAudioFileRequest(gateway, step, stepTimeout, gatewayPort);

            lastResponse = { headers: result.responseHeaders };
            lastResponseBody = result.body;
            lastResponseStatus = result.status;

            spinner.setText(`Audio file request sent, status: ${lastResponseStatus}`);
          } catch (error) {
            throw new Error(`Audio file request failed: ${error.message}`);
          }
          break;
        }

        case 'send-file-upload-request': {
          const gateway = await this.getGatewayAddress(gatewayNamespace, gatewayName);
          if (!gateway) {
            throw new Error('Gateway address not found - ensure gateway is deployed');
          }

          spinner.setText(`Sending file upload request to ${gateway}...`);

          try {
            const stepTimeout = step.timeout || testTimeout;
            const result = await this.sendFileUploadRequest(
              gateway,
              step,
              stepTimeout,
              gatewayPort
            );

            lastResponse = { ...result.response, headers: result.responseHeaders };
            lastResponseBody = result.body;
            lastResponseStatus = result.status;

            spinner.setText(`File upload request sent, status: ${lastResponseStatus}`);
          } catch (error) {
            throw new Error(`File upload request failed: ${error.message}`);
          }
          break;
        }

        case 'verify': {
          spinner.setText('Verifying response...');

          if (!lastResponse) {
            throw new Error('No response to verify - send-request must come before verify');
          }

          const verifyStep = this.interpolateVerifyStepTokens(step, { bearerToken, actorToken });

          await this.verifyResponse(
            lastResponse,
            lastResponseBody,
            lastResponseStatus,
            verifyStep,
            spinner
          );
          break;
        }

        case 'send-mcp-request': {
          const mcpGateway = await this.getGatewayAddress(gatewayNamespace, gatewayName);
          if (!mcpGateway) {
            throw new Error('Gateway address not found - ensure gateway is deployed');
          }

          if (step.auth === 'bearer' && bearerToken) {
            step.headers = { ...step.headers, Authorization: `Bearer ${bearerToken}` };
          }

          spinner.setText(`Sending MCP request (${step.method}) to ${mcpGateway}...`);

          try {
            const stepTimeout = step.timeout || testTimeout;
            const maxRetries = step.retries ?? 0;
            const retryDelay = step.retryDelay ?? 3000;
            let result;

            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
              result = await this.sendMcpRequest(
                mcpGateway,
                step,
                spinner,
                stepTimeout,
                gatewayPort
              );
              if (result.status < 500 || attempt > maxRetries) break;
              spinner.setText(
                `MCP request returned ${result.status}, retrying in ${retryDelay / 1000}s (${attempt}/${maxRetries})...`
              );
              await new Promise(r => setTimeout(r, retryDelay));
            }

            lastResponse = { ...result.response, headers: result.responseHeaders };
            lastResponseBody = result.body;
            lastResponseStatus = result.status;

            if (step.showTraffic || test.showTraffic) {
              const prevText = spinner.spinner.text;
              spinner.stop();
              printTrafficBox(result.requestInfo, {
                status: result.status,
                headers: result.responseHeaders,
                body: result.body,
              });
              spinner.start(prevText);
            }

            spinner.setText(`MCP request sent, status: ${lastResponseStatus}`);
          } catch (error) {
            throw new Error(`MCP request failed: ${error.message}`);
          }
          break;
        }

        case 'verify-resource': {
          const { kind, name: resName, namespace: resNs, expect: resExpect } = step;
          const ns = resNs || gatewayNamespace;
          spinner.setText(`Verifying ${kind} '${resName}' in ${ns}...`);

          for (const check of resExpect) {
            const result = await KubernetesHelper.kubectl(
              ['get', kind, resName, '-n', ns, '-o', `jsonpath=${check.jsonpath}`],
              { ignoreError: true }
            );

            const actual = result.stdout.trim();
            const expected = String(check.value);

            if (actual !== expected) {
              throw new Error(
                `${kind} '${resName}' field ${check.jsonpath}: expected '${expected}', got '${actual}'`
              );
            }
          }
          break;
        }

        case 'wait': {
          const duration = step.duration || 1000;
          spinner.setText(`Waiting ${duration / 1000}s for cache expiration...`);
          await new Promise(r => setTimeout(r, duration));
          break;
        }

        case 'scale-deployment': {
          const ns = step.namespace || gatewayNamespace;
          const replicas = step.replicas ?? 0;
          spinner.setText(`Scaling deployment ${ns}/${step.name} to ${replicas} replica(s)...`);
          await KubernetesHelper.kubectl([
            'scale',
            'deployment',
            step.name,
            '-n',
            ns,
            '--replicas',
            String(replicas),
          ]);
          break;
        }

        case 'set-budget-usage': {
          const entityType = step.entityType || 'provider';
          const name = step.name || 'openai';
          const usage = step.usage || 0;
          const budgetNs = step.namespace || 'agentgateway-system';

          spinner.setText(`Setting budget usage for ${entityType}/${name} to $${usage}...`);

          const sqlCmd = `UPDATE budget_definitions SET current_usage_usd = ${usage} WHERE entity_type = '${entityType}' AND name = '${name}'`;

          await KubernetesHelper.kubectl([
            'exec',
            '-n',
            budgetNs,
            'quota-management-postgres-0',
            '--',
            'psql',
            '-U',
            'budget',
            '-d',
            'budget_management',
            '-c',
            sqlCmd,
          ]);

          spinner.setText(`Budget usage set to $${usage} for ${entityType}/${name}`);
          break;
        }

        case 'reset-budget-usage': {
          const entityType = step.entityType || 'provider';
          const name = step.name || 'openai';
          const budgetNs = step.namespace || 'agentgateway-system';
          const budgetService = step.service || 'quota-management';
          const budgetPort = step.port || 8080;
          const localPort = step.localPort || 18081;

          spinner.setText(`Resetting budget usage for ${entityType}/${name}...`);

          const { cleanup } = await this.startPortForward(
            budgetNs,
            budgetService,
            localPort,
            budgetPort,
            'reset-budget-usage'
          );

          try {
            const listResult = await CommandRunner.run(
              'curl',
              ['-s', '--max-time', '10', `http://localhost:${localPort}/api/v1/budgets`],
              { ignoreError: true }
            );

            const response = JSON.parse(listResult.stdout || '{"budgets":[]}');
            const budgets = response.budgets || [];
            const budget = budgets.find(b => b.entity_type === entityType && b.name === name);

            if (!budget) {
              throw new Error(`reset-budget-usage: budget not found for ${entityType}/${name}`);
            }

            await CommandRunner.run(
              'curl',
              [
                '-s',
                '--max-time',
                '10',
                '-X',
                'POST',
                `http://localhost:${localPort}/api/v1/budgets/${budget.id}/reset`,
              ],
              { ignoreError: true }
            );

            spinner.setText(`Budget usage reset for ${entityType}/${name}`);
          } finally {
            await cleanup();
          }
          break;
        }

        case 'set-budget': {
          const entityType = step.entityType || 'provider';
          const name = step.name || 'openai';
          const amount = step.amount != null ? step.amount : 5.0;
          const budgetNs = step.namespace || 'agentgateway-system';
          const budgetService = step.service || 'quota-management';
          const budgetPort = step.port || 8080;
          const localPort = step.localPort || 18080;

          spinner.setText(`Setting budget for ${entityType}/${name} to $${amount}...`);

          const { cleanup } = await this.startPortForward(
            budgetNs,
            budgetService,
            localPort,
            budgetPort,
            'set-budget'
          );

          try {
            const listResult = await CommandRunner.run(
              'curl',
              ['-s', '--max-time', '10', `http://localhost:${localPort}/api/v1/budgets`],
              { ignoreError: true }
            );

            const response = JSON.parse(listResult.stdout || '{"budgets":[]}');
            const budgets = response.budgets || [];
            const budget = budgets.find(b => b.entity_type === entityType && b.name === name);

            if (!budget) {
              throw new Error(`set-budget: budget not found for ${entityType}/${name}`);
            }

            const updateBody = JSON.stringify({
              entity_type: entityType,
              name: name,
              budget_amount_usd: amount,
              period: budget.period || 'daily',
              match_expression: budget.match_expression || 'true',
              warning_threshold_pct: budget.warning_threshold_pct || 80,
            });

            const updateResult = await CommandRunner.run(
              'curl',
              [
                '-s',
                '--max-time',
                '10',
                '-X',
                'PUT',
                `http://localhost:${localPort}/api/v1/budgets/${budget.id}`,
                '-H',
                'Content-Type: application/json',
                '-d',
                updateBody,
              ],
              { ignoreError: true }
            );

            const updateStatus = updateResult.stdout ? JSON.parse(updateResult.stdout) : {};
            if (updateStatus.error) {
              throw new Error(`set-budget: ${updateStatus.error}`);
            }

            spinner.setText(`Budget set to $${amount} for ${entityType}/${name}`);
          } finally {
            await cleanup();
          }
          break;
        }

        case 'create-budget': {
          const entityType = step.entityType || 'provider';
          const name = step.name;
          const amount = step.amount || 10.0;
          const period = step.period || 'daily';
          const matchExpression = step.matchExpression || 'true';
          const warningThresholdPct = step.warningThresholdPct || 80;
          const description = step.description || `Budget for ${entityType}:${name}`;
          const budgetNs = step.namespace || 'agentgateway-system';
          const budgetService = step.service || 'quota-management';
          const budgetPort = step.port || 8080;
          const localPort = step.localPort || 18082;

          if (!name) {
            throw new Error('create-budget: name is required');
          }

          spinner.setText(`Creating budget for ${entityType}/${name} ($${amount}/${period})...`);

          const { cleanup } = await this.startPortForward(
            budgetNs,
            budgetService,
            localPort,
            budgetPort,
            'create-budget'
          );

          try {
            const createBody = JSON.stringify({
              entity_type: entityType,
              name: name,
              budget_amount_usd: amount,
              period: period,
              match_expression: matchExpression,
              warning_threshold_pct: warningThresholdPct,
              description: description,
            });

            const createResult = await CommandRunner.run(
              'curl',
              [
                '-s',
                '--max-time',
                '10',
                '-X',
                'POST',
                `http://localhost:${localPort}/api/v1/budgets`,
                '-H',
                'Content-Type: application/json',
                '-d',
                createBody,
              ],
              { ignoreError: true }
            );

            const result = createResult.stdout ? JSON.parse(createResult.stdout) : {};
            if (result.error) {
              Logger.warn(`create-budget: ${result.error.message || result.error}`);
            } else {
              spinner.setText(`Budget created: ${entityType}/${name} = $${amount}/${period}`);
            }
          } finally {
            await cleanup();
          }
          break;
        }

        case 'delete-budget': {
          const entityType = step.entityType || 'provider';
          const name = step.name;
          const budgetNs = step.namespace || 'agentgateway-system';
          const budgetService = step.service || 'quota-management';
          const budgetPort = step.port || 8080;
          const localPort = step.localPort || 18083;

          if (!name) {
            throw new Error('delete-budget: name is required');
          }

          spinner.setText(`Deleting budget for ${entityType}/${name}...`);

          const { cleanup } = await this.startPortForward(
            budgetNs,
            budgetService,
            localPort,
            budgetPort,
            'delete-budget'
          );

          try {
            const listResult = await CommandRunner.run(
              'curl',
              ['-s', '--max-time', '10', `http://localhost:${localPort}/api/v1/budgets`],
              { ignoreError: true }
            );

            const response = JSON.parse(listResult.stdout || '{"budgets":[]}');
            const budgets = response.budgets || [];
            const budget = budgets.find(b => b.entity_type === entityType && b.name === name);

            if (budget) {
              await CommandRunner.run(
                'curl',
                [
                  '-s',
                  '--max-time',
                  '10',
                  '-X',
                  'DELETE',
                  `http://localhost:${localPort}/api/v1/budgets/${budget.id}`,
                ],
                { ignoreError: true }
              );
              spinner.setText(`Budget deleted: ${entityType}/${name}`);
            } else {
              spinner.setText(`Budget not found: ${entityType}/${name} (skipping delete)`);
            }
          } finally {
            await cleanup();
          }
          break;
        }

        default:
          spinner.clear();
          Logger.warn(`Unknown test action: ${action}`);
          spinner.render();
      }
    }
  }

  /**
   * Obtain a token via the browser-based Authorization Code + PKCE flow.
   */
  static async getTokenViaBrowser(step) {
    const kc = step.keycloak || {};
    const realm = kc.realm || 'agw-dev';
    const clientId = kc.clientId || 'agw-client-public';
    const hostname = kc.hostname || 'keycloak.keycloak.svc.cluster.local';
    const loginTimeout = kc.timeout || 240000;

    const keycloakBase = `https://${hostname}`;

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const { callbackPort, codePromise, server } = await this.startCallbackServer(loginTimeout);

    const redirectUri = `http://localhost:${callbackPort}/callback`;
    const authorizeUrl =
      `${keycloakBase}/realms/${realm}/protocol/openid-connect/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      '&response_type=code' +
      '&scope=openid' +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge=${codeChallenge}` +
      '&code_challenge_method=S256';

    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(openCmd, [authorizeUrl], { stdio: 'ignore', detached: true }).unref();

    Logger.info(`Waiting for login (timeout: ${loginTimeout / 1000}s)...`);

    const authCode = await codePromise;
    server.close();

    Logger.debug(`Auth code received: ${authCode.substring(0, 20)}...`);
    Logger.debug(`Client ID: ${clientId}`);
    Logger.debug(`Redirect URI: ${redirectUri}`);

    const clientSecret = kc.clientSecret || process.env.KEYCLOAK_SECRET || '';
    const tokenUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/token`;
    const tokenParts = [
      'grant_type=authorization_code',
      `client_id=${encodeURIComponent(clientId)}`,
      `code=${encodeURIComponent(authCode)}`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `code_verifier=${encodeURIComponent(codeVerifier)}`,
    ];
    if (clientSecret) tokenParts.push(`client_secret=${encodeURIComponent(clientSecret)}`);
    const tokenBody = tokenParts.join('&');

    Logger.debug(`Token URL: ${tokenUrl}`);
    Logger.debug(`Token body: ${tokenBody.substring(0, 200)}...`);

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        tokenUrl,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-d',
        tokenBody,
      ],
      { ignoreError: true }
    );

    const body = (result.stdout || '').trim();
    const curlErr = (result.stderr || '').trim();

    Logger.debug(`Token response length: ${body.length} chars`);
    if (curlErr) Logger.debug(`Token curl stderr: ${curlErr}`);

    if (!body) {
      throw new Error('Token exchange failed: empty response from Keycloak');
    }

    let tokenResp;
    try {
      tokenResp = JSON.parse(body);
    } catch {
      throw new Error(
        `Token exchange: invalid JSON response from Keycloak: ${body.substring(0, 200)}`
      );
    }

    if (tokenResp.error) {
      throw new Error(`Token exchange failed: ${tokenResp.error_description || tokenResp.error}`);
    }

    if (!tokenResp.access_token) {
      throw new Error('Token exchange: no access_token in response');
    }

    return tokenResp.access_token;
  }

  /**
   * Complete a real interactive Okta login for eager-auth-okta: discover the
   * gateway-proxied authorization-server metadata, open a browser to Okta's real
   * /authorize using the pre-registered clientId directly (Okta has no usable Dynamic
   * Client Registration, so like getTokenViaBrowserEntra there's no DCR call here),
   * wait for the callback, exchange the code directly at Okta's real token endpoint -
   * no controller involved anywhere in this flow. Public/PKCE client, no secret
   * needed. Returns a genuine Okta-issued JWT.
   */
  static async getTokenViaBrowserOkta(step) {
    const okta = step.okta || {};
    const loginTimeout = okta.timeout || 240000;
    const clientId = okta.clientId || process.env.OKTA_ISSUER_CLIENT_ID;
    if (!clientId) {
      throw new Error('get-token okta requires clientId (or OKTA_ISSUER_CLIENT_ID env var)');
    }
    if (!okta.discoveryUrl) {
      throw new Error(
        "get-token okta requires discoveryUrl (the gateway's .well-known/oauth-authorization-server URL)"
      );
    }

    const metaResult = await CommandRunner.run(
      'curl',
      ['-sSk', '--max-time', '10', okta.discoveryUrl],
      { ignoreError: true }
    );
    const metaBody = (metaResult.stdout || '').trim();
    if (!metaBody) throw new Error('get-token okta: empty authorization-server metadata response');

    let metadata;
    try {
      metadata = JSON.parse(metaBody);
    } catch {
      throw new Error(
        `get-token okta: invalid authorization-server metadata JSON: ${metaBody.substring(0, 200)}`
      );
    }
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error(
        'get-token okta: authorization-server metadata missing authorization_endpoint/token_endpoint'
      );
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(12).toString('base64url');

    // Okta requires the redirect_uri's port to be individually pre-registered in the
    // app's Login redirect URIs - no any-port/wildcard loopback matching like Auth0's or
    // Entra's native-app handling (confirmed: Okta rejects any port not on that list).
    // A fixed port keeps this to a single one-time registration instead of a new
    // rejected port every run.
    const callbackPort = okta.callbackPort || 8765;
    const { codePromise, server } = await this.startCallbackServer(loginTimeout, callbackPort);
    const redirectUri = `http://localhost:${callbackPort}/callback`;

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', okta.scope || 'openid');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(openCmd, [authorizeUrl.toString()], { stdio: 'ignore', detached: true }).unref();

    Logger.info(`Waiting for login (timeout: ${loginTimeout / 1000}s)...`);
    const authCode = await codePromise;
    server.close();

    const tokenParts = [
      'grant_type=authorization_code',
      `client_id=${encodeURIComponent(clientId)}`,
      `code=${encodeURIComponent(authCode)}`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `code_verifier=${encodeURIComponent(codeVerifier)}`,
    ];

    const tokenResult = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        metadata.token_endpoint,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-d',
        tokenParts.join('&'),
      ],
      { ignoreError: true }
    );

    const body = (tokenResult.stdout || '').trim();
    if (!body) throw new Error('Okta token exchange failed: empty response from token endpoint');

    let tokenResp;
    try {
      tokenResp = JSON.parse(body);
    } catch {
      throw new Error(`Okta token exchange: invalid JSON response: ${body.substring(0, 200)}`);
    }
    if (tokenResp.error) {
      throw new Error(
        `Okta token exchange failed: ${tokenResp.error_description || tokenResp.error}`
      );
    }
    if (!tokenResp.access_token) {
      throw new Error('Okta token exchange: no access_token in response');
    }

    return tokenResp.access_token;
  }

  /**
   * Complete a real interactive Auth0 login for eager-auth-auth0: dynamically
   * register a fresh client (RFC 7591, discovered via the gateway's proxied
   * authorization-server metadata), open a browser to Auth0's real /authorize
   * (audience already injected by the gateway's adapter), wait for the callback,
   * exchange the code directly at Auth0's real token endpoint - no controller
   * involved anywhere in this flow. Returns a genuine Auth0-issued JWT.
   */
  static async getTokenViaBrowserAuth0(step) {
    const auth0 = step.auth0 || {};
    const loginTimeout = auth0.timeout || 240000;

    if (!auth0.discoveryUrl) {
      throw new Error(
        "get-token auth0 requires discoveryUrl (the gateway's .well-known/oauth-authorization-server URL)"
      );
    }
    const discoveryUrl = auth0.discoveryUrl;

    const metaResult = await CommandRunner.run('curl', ['-sSk', '--max-time', '10', discoveryUrl], {
      ignoreError: true,
    });
    const metaBody = (metaResult.stdout || '').trim();
    if (!metaBody) throw new Error('get-token auth0: empty authorization-server metadata response');

    let metadata;
    try {
      metadata = JSON.parse(metaBody);
    } catch {
      throw new Error(
        `get-token auth0: invalid authorization-server metadata JSON: ${metaBody.substring(0, 200)}`
      );
    }
    if (
      !metadata.registration_endpoint ||
      !metadata.authorization_endpoint ||
      !metadata.token_endpoint
    ) {
      throw new Error(
        'get-token auth0: authorization-server metadata missing registration_endpoint/authorization_endpoint/token_endpoint'
      );
    }

    const { callbackPort, codePromise, server } = await this.startCallbackServer(loginTimeout);
    const redirectUri = `http://localhost:${callbackPort}/callback`;

    // Real DCR - Auth0 rejects client_credentials for self-registered clients, and
    // the redirect_uri must be registered up front, so this has to happen after the
    // callback server (and its port) exists but before the browser opens.
    const registered = await this.registerClientViaDiscovery(null, null, {
      discoveryUrl,
      redirectUris: [redirectUri],
      grantTypes: ['authorization_code', 'refresh_token'],
    });

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(12).toString('base64url');

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set('client_id', registered.clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', auth0.scope || 'openid profile');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(openCmd, [authorizeUrl.toString()], { stdio: 'ignore', detached: true }).unref();

    Logger.info(`Waiting for login (timeout: ${loginTimeout / 1000}s)...`);
    const authCode = await codePromise;
    server.close();

    const tokenParts = [
      'grant_type=authorization_code',
      `client_id=${encodeURIComponent(registered.clientId)}`,
      `code=${encodeURIComponent(authCode)}`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `code_verifier=${encodeURIComponent(codeVerifier)}`,
    ];

    const tokenResult = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        metadata.token_endpoint,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-d',
        tokenParts.join('&'),
      ],
      { ignoreError: true }
    );

    const body = (tokenResult.stdout || '').trim();
    if (!body) throw new Error('Auth0 token exchange failed: empty response from token endpoint');

    let tokenResp;
    try {
      tokenResp = JSON.parse(body);
    } catch {
      throw new Error(`Auth0 token exchange: invalid JSON response: ${body.substring(0, 200)}`);
    }
    if (tokenResp.error) {
      throw new Error(
        `Auth0 token exchange failed: ${tokenResp.error_description || tokenResp.error}`
      );
    }
    if (!tokenResp.access_token) {
      throw new Error('Auth0 token exchange: no access_token in response');
    }

    return tokenResp.access_token;
  }

  /**
   * Obtain a token via password grant (resource owner credentials) or client_credentials grant.
   */
  static async getTokenViaPasswordGrant(step, registeredClient = null) {
    const kc = step.keycloak || {};
    const realm = kc.realm || 'agw-dev';
    const clientId = kc.clientId || registeredClient?.clientId || 'agw-client-public';
    const hostname = kc.hostname || 'keycloak.keycloak.svc.cluster.local';
    const grantType = kc.grantType || 'password';
    const scheme = kc.scheme || 'https';

    const keycloakBase = `${scheme}://${hostname}`;
    const tokenUrl = `${keycloakBase}/realms/${realm}/protocol/openid-connect/token`;

    const tokenParts = [`grant_type=${grantType}`, `client_id=${encodeURIComponent(clientId)}`];

    if (grantType === 'password') {
      const username = kc.username || process.env.KEYCLOAK_USERNAME;
      const password = kc.password || process.env.KEYCLOAK_PASSWORD;
      if (!username || !password) {
        throw new Error(
          'password grant requires username and password (set via step config or KEYCLOAK_USERNAME/KEYCLOAK_PASSWORD env vars)'
        );
      }
      tokenParts.push(`username=${encodeURIComponent(username)}`);
      tokenParts.push(`password=${encodeURIComponent(password)}`);
    }

    const clientSecret =
      kc.clientSecret || registeredClient?.clientSecret || process.env.KEYCLOAK_SECRET;
    if (clientSecret) {
      tokenParts.push(`client_secret=${encodeURIComponent(clientSecret)}`);
    }

    const tokenBody = tokenParts.join('&');

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        tokenUrl,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-d',
        tokenBody,
      ],
      { ignoreError: true }
    );

    const body = (result.stdout || '').trim();
    if (!body) {
      throw new Error(`${grantType} grant failed: empty response from Keycloak`);
    }

    let tokenResp;
    try {
      tokenResp = JSON.parse(body);
    } catch {
      throw new Error(`${grantType} grant: invalid JSON response`);
    }

    if (tokenResp.error) {
      throw new Error(
        `${grantType} grant failed: ${tokenResp.error_description || tokenResp.error}`
      );
    }

    if (!tokenResp.access_token) {
      throw new Error(`${grantType} grant: no access_token in response`);
    }

    return tokenResp.access_token;
  }

  /**
   * Dynamically register an OAuth client via Keycloak's Dynamic Client
   * Registration endpoint (RFC 7591), anonymously - proves the registration
   * policies mcp-auth's configureDynamicRegistration removes are actually
   * open, the same way a real MCP client (e.g. MCP Inspector) would hit them
   * on first connect. Returns { clientId, clientSecret } for a subsequent
   * get-token step to use.
   */
  static async registerClient(step) {
    const kc = step.keycloak || {};
    const realm = kc.realm || 'agw-dev';
    const hostname = kc.hostname || 'keycloak.keycloak.svc.cluster.local';
    const scheme = kc.scheme || 'https';
    const clientName = kc.clientName || `dcr-test-${randomBytes(4).toString('hex')}`;
    const redirectUris = kc.redirectUris || ['http://127.0.0.1:6276/oauth/callback'];
    const grantTypes = kc.grantTypes || ['client_credentials'];

    const keycloakBase = `${scheme}://${hostname}`;
    const registrationUrl = `${keycloakBase}/realms/${realm}/clients-registrations/openid-connect`;

    const payload = {
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      // 'client_secret_post', not the RFC 7591 default 'client_secret_basic' - this
      // matches how getTokenViaPasswordGrant submits credentials (client_secret in the
      // POST body, not an HTTP Basic Auth header) for every other grant in this file.
      token_endpoint_auth_method: kc.public ? 'none' : 'client_secret_post',
    };

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        registrationUrl,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
      ],
      { ignoreError: true }
    );

    const body = (result.stdout || '').trim();
    if (!body) {
      throw new Error('Dynamic client registration failed: empty response from Keycloak');
    }

    let regResp;
    try {
      regResp = JSON.parse(body);
    } catch {
      throw new Error(
        `Dynamic client registration: invalid JSON response: ${body.substring(0, 200)}`
      );
    }

    if (regResp.error) {
      throw new Error(
        `Dynamic client registration failed: ${regResp.error_description || regResp.error}`
      );
    }

    if (!regResp.client_id) {
      throw new Error('Dynamic client registration: no client_id in response');
    }

    return { clientId: regResp.client_id, clientSecret: regResp.client_secret };
  }

  /**
   * Dynamically register an OAuth client by first discovering the
   * `registration_endpoint` from an authorization server metadata document,
   * then POSTing to it (RFC 7591 + RFC 8414). Unlike registerClient (which
   * hits Keycloak's well-known registration URL directly), this is
   * provider-agnostic - needed for providers like Okta/Auth0 where the
   * gateway itself proxies DCR to the real IdP (or, for eager-auth-okta,
   * mocks it) and the registration_endpoint isn't a fixed, guessable path.
   *
   * step.discoveryUrl: a fully-qualified metadata URL, used as-is (gateway/
   * port args are ignored) - for issuers not reachable via the gateway's own
   * LB address, e.g. eager-auth-okta's controller-hosted issuer on the
   * profile's public HTTPS listener. Otherwise step.discoveryEndpoint is
   * resolved against http://<gateway>:<port>.
   */
  static async registerClientViaDiscovery(gateway, port, step) {
    const discoveryUrl = step.discoveryUrl || `http://${gateway}:${port}${step.discoveryEndpoint}`;

    const metaResult = await CommandRunner.run('curl', ['-sSk', '--max-time', '10', discoveryUrl], {
      ignoreError: true,
    });
    const metaBody = (metaResult.stdout || '').trim();
    if (!metaBody) {
      throw new Error('Dynamic client registration: empty authorization-server metadata response');
    }

    let metadata;
    try {
      metadata = JSON.parse(metaBody);
    } catch {
      throw new Error(
        `Dynamic client registration: invalid authorization-server metadata JSON: ${metaBody.substring(0, 200)}`
      );
    }

    const registrationUrl = metadata.registration_endpoint;
    if (!registrationUrl) {
      throw new Error(
        'Dynamic client registration: authorization-server metadata has no registration_endpoint'
      );
    }

    const clientName = step.clientName || `dcr-test-${randomBytes(4).toString('hex')}`;
    const redirectUris = step.redirectUris || ['http://127.0.0.1:6276/oauth/callback'];
    // Real MCP clients are public clients using authorization_code + PKCE, never
    // client_credentials - and IdPs like Auth0 reject client_credentials on a
    // self-registered client outright ("DCR clients must have at least one supported
    // grant type. Supported: authorization_code, refresh_token.", live-verified).
    const grantTypes = step.grantTypes || ['authorization_code', 'refresh_token'];

    const payload = {
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: step.public === false ? 'client_secret_basic' : 'none',
    };

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        registrationUrl,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
      ],
      { ignoreError: true }
    );

    const body = (result.stdout || '').trim();
    if (!body) {
      throw new Error('Dynamic client registration failed: empty response');
    }

    let regResp;
    try {
      regResp = JSON.parse(body);
    } catch {
      throw new Error(
        `Dynamic client registration: invalid JSON response: ${body.substring(0, 200)}`
      );
    }

    if (regResp.error) {
      throw new Error(
        `Dynamic client registration failed: ${regResp.error_description || regResp.error}`
      );
    }

    if (!regResp.client_id) {
      throw new Error('Dynamic client registration: no client_id in response');
    }

    return { clientId: regResp.client_id, clientSecret: regResp.client_secret };
  }

  /**
   * Obtain a token from Microsoft Entra ID via the client_credentials grant.
   *
   * Uses the v1 token endpoint (not /oauth2/v2.0/token) so the resulting token's
   * issuer is `https://sts.windows.net/<tenantId>/` and `resource` sets the
   * audience - matching entra-jwt-auth's default (v1-format) expectations without
   * requiring the app registration's accessTokenAcceptedVersion to be changed.
   */
  static async getTokenViaEntraClientCredentials(step) {
    const entra = step.entra || {};
    const tenantId = entra.tenantId;
    const clientId = entra.clientId;
    if (!tenantId || !clientId) {
      throw new Error('Entra client_credentials grant requires entra.tenantId and entra.clientId');
    }

    const clientSecret =
      entra.clientSecret || process.env[entra.clientSecretEnvVar || 'ENTRA_ISSUER_CLIENT_SECRET'];
    if (!clientSecret) {
      const error = new Error(
        'no ENTRA_ISSUER_CLIENT_SECRET (or entra.clientSecret) set - requires a real Entra app registration'
      );
      error.skipped = true;
      throw error;
    }

    const resource = entra.resource || `api://${clientId}`;
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;
    const tokenBody = [
      'grant_type=client_credentials',
      `client_id=${encodeURIComponent(clientId)}`,
      `client_secret=${encodeURIComponent(clientSecret)}`,
      `resource=${encodeURIComponent(resource)}`,
    ].join('&');

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        tokenUrl,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-d',
        tokenBody,
      ],
      { ignoreError: true }
    );

    const body = (result.stdout || '').trim();
    if (!body) {
      throw new Error('Entra client_credentials grant failed: empty response');
    }

    let tokenResp;
    try {
      tokenResp = JSON.parse(body);
    } catch {
      throw new Error(
        `Entra client_credentials grant: invalid JSON response: ${body.substring(0, 200)}`
      );
    }

    if (tokenResp.error) {
      throw new Error(
        `Entra client_credentials grant failed: ${tokenResp.error_description || tokenResp.error}`
      );
    }

    if (!tokenResp.access_token) {
      throw new Error('Entra client_credentials grant: no access_token in response');
    }

    return tokenResp.access_token;
  }

  /**
   * Complete a real interactive Entra ID login for eager-auth-entra: discover the
   * gateway-proxied authorization-server metadata, open a browser to Entra's real
   * /authorize using the pre-registered clientId directly (Entra has no Dynamic
   * Client Registration, so unlike getTokenViaBrowserAuth0 there's no DCR call here),
   * wait for the callback, exchange the code directly at Entra's real token endpoint -
   * no controller involved anywhere in this flow. Public/PKCE client, no secret
   * needed. Unlike getTokenViaBrowserOkta, no `resource` param is sent - Entra
   * rejects RFC 8707 `resource` on /authorize, and the adapter strips it anyway - so
   * the scope must carry the exposed custom-API scope to mint a token audienced for
   * this app registration. Returns a genuine Entra-issued JWT.
   */
  static async getTokenViaBrowserEntra(step) {
    const entra = step.entra || {};
    const loginTimeout = entra.timeout || 240000;
    const clientId = entra.clientId;
    if (!clientId) {
      throw new Error('get-token entra requires clientId');
    }
    if (!entra.discoveryUrl) {
      throw new Error(
        "get-token entra requires discoveryUrl (the gateway's .well-known/oauth-authorization-server URL)"
      );
    }

    const metaResult = await CommandRunner.run(
      'curl',
      ['-sSk', '--max-time', '10', entra.discoveryUrl],
      { ignoreError: true }
    );
    const metaBody = (metaResult.stdout || '').trim();
    if (!metaBody) {
      throw new Error('get-token entra: empty authorization-server metadata response');
    }

    let metadata;
    try {
      metadata = JSON.parse(metaBody);
    } catch {
      throw new Error(
        `get-token entra: invalid authorization-server metadata JSON: ${metaBody.substring(0, 200)}`
      );
    }
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error(
        'get-token entra: authorization-server metadata missing authorization_endpoint/token_endpoint'
      );
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(12).toString('base64url');

    const { callbackPort, codePromise, server } = await this.startCallbackServer(loginTimeout);
    const redirectUri = `http://localhost:${callbackPort}/callback`;

    const scopeName = entra.scopeName || 'mcp_access';
    const defaultScope = `openid api://${clientId}/${scopeName}`;

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', entra.scope || defaultScope);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(openCmd, [authorizeUrl.toString()], { stdio: 'ignore', detached: true }).unref();

    Logger.info(`Waiting for login (timeout: ${loginTimeout / 1000}s)...`);
    const authCode = await codePromise;
    server.close();

    const tokenParts = [
      'grant_type=authorization_code',
      `client_id=${encodeURIComponent(clientId)}`,
      `code=${encodeURIComponent(authCode)}`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `code_verifier=${encodeURIComponent(codeVerifier)}`,
    ];

    const tokenResult = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '--max-time',
        '10',
        '-X',
        'POST',
        metadata.token_endpoint,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '-d',
        tokenParts.join('&'),
      ],
      { ignoreError: true }
    );

    const body = (tokenResult.stdout || '').trim();
    if (!body) throw new Error('Entra token exchange failed: empty response from token endpoint');

    let tokenResp;
    try {
      tokenResp = JSON.parse(body);
    } catch {
      throw new Error(`Entra token exchange: invalid JSON response: ${body.substring(0, 200)}`);
    }
    if (tokenResp.error) {
      throw new Error(
        `Entra token exchange failed: ${tokenResp.error_description || tokenResp.error}`
      );
    }
    if (!tokenResp.access_token) {
      throw new Error('Entra token exchange: no access_token in response');
    }

    return tokenResp.access_token;
  }

  /**
   * Get a session cookie via browser-based OAuth2 + session flow.
   */
  static async getSessionCookie(gatewayAddress, gatewayPort, step) {
    // Unlike getTokenViaBrowser (a native/PKCE client with its own loopback
    // redirect_uri), this flow's redirect_uri is the GATEWAY itself - the ext-auth
    // service exchanges the code and sets the session cookie server-side, and the
    // browser never touches localhost at all. So this scripts the whole dance with
    // curl instead of opening a real browser and waiting on a local callback (which
    // would never receive a request).
    const scheme = step.scheme === 'https' ? 'https' : 'http';
    const hostname = step.resolve?.hostname || gatewayAddress;
    const port = step.port ?? gatewayPort;
    const startPath = step.endpoint || '/openai/v1/chat/completions';
    const cookieName = step.cookieName || 'session';
    const username = step.username || process.env.KEYCLOAK_USERNAME || 'user1';
    const password = step.password || process.env.KEYCLOAK_PASSWORD || 'Password1!';
    const timeout = step.timeout || 15000;

    const startUrl = `${scheme}://${hostname}:${port}${startPath}`;
    const cookieJar = join(tmpdir(), `agw-test-oauth-cookies-${randomBytes(6).toString('hex')}`);
    const headerFile = join(tmpdir(), `agw-test-oauth-headers-${randomBytes(6).toString('hex')}`);

    const curlTo = async (url, outFile, extraArgs = []) => {
      await CommandRunner.run(
        'curl',
        [
          '-sk',
          '--max-time',
          String(Math.ceil(timeout / 1000)),
          '-D',
          headerFile,
          '-o',
          outFile,
          '-b',
          cookieJar,
          '-c',
          cookieJar,
          url,
          ...extraArgs,
        ],
        { ignoreError: true }
      );
      return readFile(headerFile, 'utf8');
    };

    const locationOf = headers => {
      const m = headers.match(/^location:\s*(\S+)/im);
      return m ? m[1] : null;
    };

    const loginPagePath = join(
      tmpdir(),
      `agw-test-oauth-login-${randomBytes(6).toString('hex')}.html`
    );
    try {
      Logger.info(`Requesting ${startUrl} to trigger the OAuth2 redirect...`);
      let headers = await curlTo(startUrl, '/dev/null');
      const authorizeUrl = locationOf(headers);
      if (!authorizeUrl) {
        throw new Error(
          `Expected a redirect to the IdP from ${startUrl} - got no Location header. Response:\n${headers}`
        );
      }

      headers = await curlTo(authorizeUrl, loginPagePath);
      const loginPage = await readFile(loginPagePath, 'utf8');
      const actionMatch = loginPage.match(/"loginAction":\s*"([^"]+)"/);
      if (!actionMatch) {
        throw new Error(`Could not find the Keycloak login form action at ${authorizeUrl}`);
      }
      const loginAction = actionMatch[1].replace(/\\\//g, '/');

      Logger.info('Submitting Keycloak login form...');
      headers = await curlTo(loginAction, '/dev/null', [
        '-X',
        'POST',
        '--data-urlencode',
        `username=${username}`,
        '--data-urlencode',
        `password=${password}`,
        '--data-urlencode',
        'credentialId=',
      ]);
      const callbackUrl = locationOf(headers);
      if (!callbackUrl) {
        throw new Error(
          `Keycloak login did not redirect back to the gateway - check username/password. Response:\n${headers}`
        );
      }

      headers = await curlTo(callbackUrl, '/dev/null');
      const cookieMatch = headers.match(new RegExp(`set-cookie:\\s*(${cookieName}=[^;]+)`, 'i'));
      if (!cookieMatch) {
        throw new Error(
          `Gateway callback at ${callbackUrl} did not set the '${cookieName}' cookie`
        );
      }
      return cookieMatch[1];
    } finally {
      await unlink(cookieJar).catch(() => {});
      await unlink(headerFile).catch(() => {});
      await unlink(loginPagePath).catch(() => {});
    }
  }

  /**
   * Start a local callback server for OAuth2 flows. Binds an OS-assigned ephemeral
   * port by default; pass a fixed `port` for IdPs that require an exact, pre-registered
   * redirect_uri with no wildcard/any-port matching (e.g. Okta - confirmed it rejects
   * any port not in the app's Login redirect URIs list, unlike Auth0/Entra's native-app
   * loopback handling).
   */
  static startCallbackServer(timeout, port = 0) {
    return new Promise((resolve, _reject) => {
      let codeResolve;
      let codeReject;
      const codePromise = new Promise((res, rej) => {
        codeResolve = res;
        codeReject = rej;
      });

      const server = createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');
          const errorDesc = url.searchParams.get('error_description');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          if (error) {
            res.end(`<html><body><h1>Error: ${error}</h1><p>${errorDesc || ''}</p></body></html>`);
            codeReject(new Error(`OAuth error: ${error} - ${errorDesc}`));
          } else if (code) {
            res.end('<html><body><h1>Login successful! You may close this tab.</h1></body></html>');
            codeResolve(code);
          } else {
            res.end('<html><body><h1>No code received</h1></body></html>');
            codeReject(new Error('No authorization code in callback'));
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      server.listen(port, '127.0.0.1', () => {
        const { port: boundPort } = server.address();
        Logger.debug(`Callback server listening on port ${boundPort}`);
        resolve({ callbackPort: boundPort, codePromise, server });
      });

      setTimeout(() => {
        server.close();
        codeReject(new Error('Login timeout'));
      }, timeout);
    });
  }

  /**
   * Resolve TLS material (cert/key/ca) for an HTTPS test step into local file paths.
   * Each of tls.cert/tls.key/tls.ca is either an inline path string or
   * { secretRef: { name, namespace, key } }; secretRef entries are extracted from the
   * cluster into temp files under the OS tmpdir (caller must cleanupTlsMaterial after use).
   */
  static async resolveTlsMaterial(tls) {
    const DEFAULT_KEYS = { cert: 'tls.crt', key: 'tls.key', ca: 'ca.crt' };
    const paths = {};
    const tempFiles = [];

    for (const kind of ['cert', 'key', 'ca']) {
      const spec = tls[kind];
      if (!spec) continue;

      if (typeof spec === 'string') {
        paths[kind] = spec;
        continue;
      }

      if (!spec.secretRef) {
        throw new Error(`step.tls.${kind} must be a file path string or { secretRef }`);
      }

      const { name, namespace, key = DEFAULT_KEYS[kind] } = spec.secretRef;
      if (!name || !namespace) {
        throw new Error(`step.tls.${kind}.secretRef requires 'name' and 'namespace'`);
      }

      const result = await KubernetesHelper.kubectl([
        'get',
        'secret',
        name,
        '-n',
        namespace,
        '-o',
        `jsonpath={.data.${key.replace(/\./g, '\\.')}}`,
      ]);
      const b64 = (result.stdout || '').trim();
      if (!b64) {
        throw new Error(`TLS ${kind} not found in secret ${namespace}/${name} key=${key}`);
      }

      const tmpPath = join(tmpdir(), `agw-test-${kind}-${randomBytes(6).toString('hex')}`);
      await writeFile(tmpPath, Buffer.from(b64, 'base64'), { mode: 0o600 });
      paths[kind] = tmpPath;
      tempFiles.push(tmpPath);
    }

    return { paths, tempFiles };
  }

  static async cleanupTlsMaterial(tempFiles = []) {
    await Promise.all(tempFiles.map(f => unlink(f).catch(() => {})));
  }

  /**
   * Send an HTTP request to the gateway
   */
  static async sendHttpRequest(gateway, step, spinner, timeout = 15000, port = 8080) {
    const endpoint = step.endpoint || '/openai/v1/chat/completions';
    const method = step.method || 'POST';
    const headers = step.headers || {};
    const prompt = step.prompt || 'Hello';
    const model = step.model;
    const scheme = step.scheme === 'https' ? 'https' : 'http';
    // https defaults to 443 unless the step overrides the port explicitly.
    const effectivePort = step.port ?? (scheme === 'https' ? 443 : port);
    // step.resolve lets the URL/SNI use a hostname distinct from the gateway address
    // (e.g. SNI-matching), while curl's --resolve maps it back to the real IP.
    const urlHost = step.resolve?.hostname || gateway;

    // GET/HEAD carry no request body — attaching one via curl's -d would force a body
    // curl doesn't send by default for these methods, breaking passthrough routes like /v1/models.
    const methodAllowsBody = !['GET', 'HEAD'].includes(method.toUpperCase());

    let body;
    if (methodAllowsBody) {
      if (step.body) {
        body =
          typeof step.body === 'string'
            ? step.body
            : JSON.stringify({ ...step.body, ...step.extraFields });
      } else if (step.input !== undefined) {
        body = JSON.stringify({
          ...(model !== undefined && { model }),
          input: step.input,
          ...step.extraFields,
        });
      } else {
        body = JSON.stringify({
          ...(model !== undefined && { model }),
          messages: [{ role: 'user', content: prompt }],
          ...step.extraFields,
        });
      }
    }

    const url = `${scheme}://${urlHost}:${effectivePort}${endpoint}`;

    const headerArgs = [];
    if (methodAllowsBody && !headers['Content-Type']) {
      headerArgs.push('-H', 'Content-Type: application/json');
    }
    for (const [k, v] of Object.entries(headers)) {
      headerArgs.push('-H', `${k}: ${v}`);
    }

    let tlsMaterial = null;
    if (step.tls) {
      tlsMaterial = await this.resolveTlsMaterial(step.tls);
    }

    try {
      const curlArgs = [
        '-sS',
        '--max-time',
        String(Math.ceil(timeout / 1000)),
        '-X',
        method,
        url,
        ...headerArgs,
        ...(methodAllowsBody ? ['-d', body] : []),
        '-w',
        '\n%{http_code}',
        '-D',
        '/dev/stderr',
      ];

      if (scheme === 'https') {
        if (tlsMaterial?.paths.ca) {
          curlArgs.push('--cacert', tlsMaterial.paths.ca);
        } else {
          // Demo certs are typically self-signed/cert-manager issued and not in the
          // local trust store; skip server verification unless a CA was supplied.
          curlArgs.push('-k');
        }
        if (tlsMaterial?.paths.cert) curlArgs.push('--cert', tlsMaterial.paths.cert);
        if (tlsMaterial?.paths.key) curlArgs.push('--key', tlsMaterial.paths.key);
      }

      if (step.resolve) {
        // --connect-to (not --resolve) because the target can be a hostname (e.g. a cloud
        // load balancer's DNS name, common on AWS) as well as an IP - --resolve only accepts
        // a literal IP and fails to parse otherwise. Both preserve the original host for the
        // Host header and TLS SNI, only redirecting the actual TCP connection.
        const resolveTarget = step.resolve.ip || gateway;
        curlArgs.push(
          '--connect-to',
          `${step.resolve.hostname}:${effectivePort}:${resolveTarget}:${effectivePort}`
        );
      }

      Logger.debug(`curl command: curl ${curlArgs.join(' ')}`);

      const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });
      const connectionFailed = result.failed === true;

      const raw = (result.stdout || '').trim();
      const lines = raw.split('\n');
      const httpStatus = parseInt(lines[lines.length - 1], 10);
      const responseBody = lines.slice(0, -1).join('\n').trim();

      const responseHeaders = {};
      // Split by \r\n or \n to handle HTTP headers properly
      const stderrLines = (result.stderr || '').split(/\r?\n/);
      for (const line of stderrLines) {
        // Remove any trailing \r and match header pattern
        const cleanLine = line.replace(/\r$/, '');
        const match = cleanLine.match(/^([^:]+):\s*(.+)$/);
        if (match) {
          responseHeaders[match[1].toLowerCase()] = match[2].trim();
        }
      }

      // Debug: log captured headers
      const headerKeys = Object.keys(responseHeaders);
      if (headerKeys.length > 0) {
        Logger.debug(`Captured response headers: ${headerKeys.join(', ')}`);
      } else {
        Logger.debug(
          `No response headers captured. stderr: ${(result.stderr || '').substring(0, 200)}`
        );
      }

      return {
        status: httpStatus,
        body: responseBody,
        response: { status: httpStatus, body: responseBody },
        responseHeaders,
        connectionFailed,
        connectionError: connectionFailed
          ? (result.stderr || '').trim() || result.shortMessage || 'curl request failed'
          : null,
        requestInfo: {
          method,
          url,
          headers: methodAllowsBody ? { 'Content-Type': 'application/json', ...headers } : headers,
          body,
        },
      };
    } finally {
      if (tlsMaterial?.tempFiles.length) {
        await this.cleanupTlsMaterial(tlsMaterial.tempFiles);
      }
    }
  }

  static async sendTtsRequest(gateway, step, spinner, timeout = 15000, port = 8080) {
    const endpoint = step.endpoint || '/openai/v1/audio/speech';
    const headers = step.headers || {};
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    const playAudio = step.playAudio || false;

    const url = `http://${gateway}:${port}${endpoint}`;

    const headerArgs = ['-H', 'Content-Type: application/json'];
    for (const [k, v] of Object.entries(headers)) {
      headerArgs.push('-H', `${k}: ${v}`);
    }

    const tempFile = playAudio ? `/tmp/tts-output-${Date.now()}.mp3` : '/dev/null';

    const curlArgs = [
      '-s',
      '--max-time',
      String(Math.ceil(timeout / 1000)),
      '-X',
      'POST',
      url,
      ...headerArgs,
      '-d',
      body,
      '-w',
      '%{http_code}|%{content_type}',
      '-D',
      '/dev/stderr',
      '-o',
      tempFile,
    ];

    Logger.debug(`curl TTS command: curl ${curlArgs.join(' ')}`);

    const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

    const stdout = (result.stdout || '').trim();
    const [httpStatusStr, contentType] = stdout.split('|');
    const httpStatus = parseInt(httpStatusStr || '0', 10);

    const responseHeaders = {};
    const stderrLines = (result.stderr || '').split(/\r?\n/);
    for (const line of stderrLines) {
      const cleanLine = line.replace(/\r$/, '');
      const match = cleanLine.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        responseHeaders[match[1].toLowerCase()] = match[2].trim();
      }
    }

    const isAudio = (contentType || '').startsWith('audio/');
    const bodyLength = parseInt(responseHeaders['content-length'] || '0', 10);

    if (playAudio && isAudio && httpStatus === 200) {
      const prevText = spinner.spinner.text;
      spinner.stop();
      Logger.info('Playing generated audio...');
      await CommandRunner.run('afplay', [tempFile], { ignoreError: true });
      spinner.start(prevText);
    }

    return {
      status: httpStatus,
      contentType: contentType || '',
      isAudio,
      body: isAudio ? `[binary audio data, ${bodyLength} bytes]` : '[non-audio response]',
      responseHeaders,
    };
  }

  static async sendAudioFileRequest(gateway, step, timeout = 15000, port = 8080) {
    const endpoint = step.endpoint || '/openai/v1/audio/transcriptions';
    const headers = step.headers || {};
    const audioFile = step.file;
    const model = step.body?.model || 'whisper-1';
    const language = step.body?.language;

    if (!audioFile) {
      throw new Error('send-audio-file-request requires a "file" field');
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(__dirname, '../..');
    const filePath = resolve(projectRoot, 'config/test-assets', audioFile);

    const url = `http://${gateway}:${port}${endpoint}`;

    const curlArgs = [
      '-s',
      '--max-time',
      String(Math.ceil(timeout / 1000)),
      '-X',
      'POST',
      url,
      '-F',
      `file=@${filePath}`,
      '-F',
      `model=${model}`,
    ];

    if (language) {
      curlArgs.push('-F', `language=${language}`);
    }

    for (const [k, v] of Object.entries(headers)) {
      curlArgs.push('-H', `${k}: ${v}`);
    }

    curlArgs.push('-w', '\n%{http_code}', '-D', '/dev/stderr');

    Logger.debug(`curl audio file command: curl ${curlArgs.join(' ')}`);

    const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

    const raw = (result.stdout || '').trim();
    const lines = raw.split('\n');
    const httpStatus = parseInt(lines[lines.length - 1], 10);
    const responseBody = lines.slice(0, -1).join('\n').trim();

    const responseHeaders = {};
    const stderrLines = (result.stderr || '').split(/\r?\n/);
    for (const line of stderrLines) {
      const cleanLine = line.replace(/\r$/, '');
      const match = cleanLine.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        responseHeaders[match[1].toLowerCase()] = match[2].trim();
      }
    }

    return {
      status: httpStatus,
      body: responseBody,
      responseHeaders,
    };
  }

  /**
   * Send a generic multipart file upload request (e.g. OpenAI's /v1/files endpoint).
   * Unlike sendAudioFileRequest, form fields are arbitrary (step.fields) rather than
   * hardcoded to model/language.
   */
  static async sendFileUploadRequest(gateway, step, timeout = 15000, port = 8080) {
    const endpoint = step.endpoint || '/v1/files';
    const headers = step.headers || {};
    const file = step.file;
    const fields = step.fields || {};

    if (!file) {
      throw new Error('send-file-upload-request requires a "file" field');
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(__dirname, '../..');
    const filePath = resolve(projectRoot, 'config/test-assets', file);

    const url = `http://${gateway}:${port}${endpoint}`;

    const curlArgs = [
      '-s',
      '--max-time',
      String(Math.ceil(timeout / 1000)),
      '-X',
      'POST',
      url,
      '-F',
      `file=@${filePath}`,
    ];

    for (const [k, v] of Object.entries(fields)) {
      curlArgs.push('-F', `${k}=${v}`);
    }
    for (const [k, v] of Object.entries(headers)) {
      curlArgs.push('-H', `${k}: ${v}`);
    }

    curlArgs.push('-w', '\n%{http_code}', '-D', '/dev/stderr');

    Logger.debug(`curl file upload command: curl ${curlArgs.join(' ')}`);

    const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

    const raw = (result.stdout || '').trim();
    const lines = raw.split('\n');
    const httpStatus = parseInt(lines[lines.length - 1], 10);
    const responseBody = lines.slice(0, -1).join('\n').trim();

    const responseHeaders = {};
    const stderrLines = (result.stderr || '').split(/\r?\n/);
    for (const line of stderrLines) {
      const cleanLine = line.replace(/\r$/, '');
      const match = cleanLine.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        responseHeaders[match[1].toLowerCase()] = match[2].trim();
      }
    }

    return {
      status: httpStatus,
      body: responseBody,
      response: { status: httpStatus, body: responseBody },
      responseHeaders,
    };
  }

  /**
   * Send an MCP request to the gateway.
   *
   * StreamableHTTP requires a session lifecycle:
   *   1. POST initialize  → get mcp-session-id from response headers
   *   2. POST actual method with mcp-session-id header
   *
   * agentgateway internally sends notifications/initialized to backends;
   * the client must NOT send it again or fd-mcp receives a duplicate and
   * resets its session state.
   *
   * If initialize itself fails (e.g. 401 from JWT policy), we return that
   * response immediately so auth-rejection tests still pass.
   */
  static async sendMcpRequest(gateway, step, spinner, timeout = 30000, port = 8080) {
    const endpoint = step.endpoint || '/mcp';
    const method = step.method || 'tools/list';
    const params = step.params || {};
    const headers = step.headers || {};

    const url = `http://${gateway}:${port}${endpoint}`;

    // Auth + custom headers shared across all sub-requests in this call.
    const authHeaderArgs = [
      '-H',
      'Content-Type: application/json',
      '-H',
      'Accept: application/json, text/event-stream',
    ];
    for (const [k, v] of Object.entries(headers)) {
      authHeaderArgs.push('-H', `${k}: ${v}`);
    }

    // Helper: parse HTTP status + body from curl stdout (\n%{http_code} format)
    const parseCurlOutput = stdout => {
      const raw = (stdout || '').trim();
      const lines = raw.split('\n');
      const status = parseInt(lines[lines.length - 1], 10);
      const body = lines.slice(0, -1).join('\n').trim();
      return { status, body };
    };

    // Helper: parse response headers from curl stderr (-D /dev/stderr format)
    const parseHeaders = stderr => {
      const result = {};
      for (const line of (stderr || '').split(/\r?\n/)) {
        const clean = line.replace(/\r$/, '');
        const m = clean.match(/^([^:]+):\s*(.+)$/);
        if (m) result[m[1].toLowerCase()] = m[2].trim();
      }
      return result;
    };

    // --- Step 1: initialize ---
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-runner', version: '1.0.0' },
      },
    };

    const initResult = await CommandRunner.run(
      'curl',
      [
        '-s',
        '--max-time',
        '15',
        '-X',
        'POST',
        url,
        ...authHeaderArgs,
        '-d',
        JSON.stringify(initRequest),
        '-w',
        '\n%{http_code}',
        '-D',
        '/dev/stderr',
      ],
      { ignoreError: true }
    );

    const { status: initStatus, body: initBodyRaw } = parseCurlOutput(initResult.stdout);
    const initHeaders = parseHeaders(initResult.stderr);

    Logger.debug(
      `MCP initialize status: ${initStatus}, session: ${initHeaders['mcp-session-id'] ? 'obtained' : 'none'}`
    );

    // If initialization failed (e.g. 401 JWT rejection), surface that immediately.
    if (initStatus < 200 || initStatus >= 300) {
      let parsedInitBody;
      try {
        parsedInitBody = JSON.parse(initBodyRaw);
      } catch {
        parsedInitBody = initBodyRaw;
      }
      return {
        status: initStatus,
        body: parsedInitBody,
        response: { status: initStatus, body: parsedInitBody },
        responseHeaders: initHeaders,
        requestInfo: { method: 'POST', url, headers, body: initRequest },
      };
    }

    const sessionId = initHeaders['mcp-session-id'] || null;
    Logger.debug(`MCP session ID: ${sessionId || '(none)'}`);

    // --- Step 2: actual request (agentgateway handles notifications/initialized internally) ---
    const mcpRequest = { jsonrpc: '2.0', id: Date.now(), method, params };

    const headerArgs = [
      '-H',
      'Content-Type: application/json',
      '-H',
      'Accept: application/json, text/event-stream',
    ];
    if (sessionId) {
      headerArgs.push('-H', `mcp-session-id: ${sessionId}`);
    }
    for (const [k, v] of Object.entries(headers)) {
      headerArgs.push('-H', `${k}: ${v}`);
    }

    const curlArgs = [
      '-s',
      '--max-time',
      String(Math.ceil(timeout / 1000)),
      '-X',
      'POST',
      url,
      ...headerArgs,
      '-d',
      JSON.stringify(mcpRequest),
      '-w',
      '\n%{http_code}',
      '-D',
      '/dev/stderr',
    ];

    Logger.debug(`MCP curl command: curl ${curlArgs.join(' ')}`);

    const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });

    const { status: httpStatus, body: responseBodyRaw } = parseCurlOutput(result.stdout);
    const responseHeaders = parseHeaders(result.stderr);

    Logger.debug(`MCP ${method} status: ${httpStatus}`);

    let parsedBody;
    try {
      parsedBody = JSON.parse(responseBodyRaw);
    } catch {
      parsedBody = responseBodyRaw;
    }

    return {
      status: httpStatus,
      body: parsedBody,
      response: { status: httpStatus, body: parsedBody },
      responseHeaders,
      requestInfo: {
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: mcpRequest,
      },
    };
  }

  /**
   * Substitute `${ENV_VAR}` placeholders in header values with process.env values, so a
   * usecase can reference a real secret (e.g. an API key) without hardcoding it - the
   * usecase yaml's own `{{env....}}` templating only resolves against the environment
   * config file, not process.env, so this is a separate, narrower mechanism scoped to
   * header values only.
   */
  static substituteEnvVarsInHeaders(headers) {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value.replace(/\$\{(\w+)\}/g, (match, name) => process.env[name] ?? match)
          : value,
      ])
    );
  }

  /**
   * Substitute {{bearerToken}}/{{actorToken}} placeholders in a verify step's
   * expect.contains/expect.notContains, so a test can assert against the exact token
   * value obtained earlier in the test (e.g. that an exchanged response no longer
   * contains the original bearer token). Returns the step unchanged if it has no
   * expect.contains/notContains to interpolate.
   */
  static interpolateVerifyStepTokens(step, { bearerToken, actorToken }) {
    if (!step.expect) return step;

    const substitute = value => {
      if (Array.isArray(value)) return value.map(substitute);
      if (typeof value !== 'string') return value;
      return value
        .replace(/\{\{bearerToken\}\}/g, bearerToken || '')
        .replace(/\{\{actorToken\}\}/g, actorToken || '');
    };

    const { contains, notContains } = step.expect;
    if (contains === undefined && notContains === undefined) return step;

    return {
      ...step,
      expect: {
        ...step.expect,
        ...(contains !== undefined && { contains: substitute(contains) }),
        ...(notContains !== undefined && { notContains: substitute(notContains) }),
      },
    };
  }

  /**
   * Verify response against expected values
   */
  static async verifyResponse(response, body, status, step, spinner) {
    const { expect = {} } = step;

    // A connection-level failure (e.g. TLS handshake rejection) has no HTTP status/body -
    // check it first and skip the remaining checks, which assume a completed response.
    if (expect.connectionError === true) {
      if (!response?.connectionFailed) {
        throw new Error(
          'Expected a connection-level error (e.g. TLS handshake failure), but the request completed with an HTTP response'
        );
      }
      return;
    }
    if (response?.connectionFailed) {
      throw new Error(`Request failed at the connection level: ${response.connectionError}`);
    }

    // Handle statusCode as an alias for numeric status check
    if (expect.statusCode !== undefined) {
      if (status !== expect.statusCode) {
        throw new Error(`Expected status code ${expect.statusCode}, got ${status}`);
      }
    }

    if (expect.status === 'success') {
      if (status < 200 || status >= 300) {
        throw new Error(`Expected success status (2xx), got ${status}`);
      }
    } else if (expect.status === 'blocked') {
      if (status !== 403) {
        throw new Error(`Expected blocked status (403), got ${status}`);
      }
    } else if (expect.status === 'error') {
      if (status < 400) {
        throw new Error(`Expected error status (4xx or 5xx), got ${status}`);
      }
    } else if (typeof expect.status === 'number') {
      if (status !== expect.status) {
        throw new Error(`Expected status ${expect.status}, got ${status}`);
      }
    }

    if (expect.contains) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      Logger.debug(`Response body:\n${bodyStr.substring(0, 2000)}`);
      const items = Array.isArray(expect.contains) ? expect.contains : [expect.contains];
      const lowerBody = bodyStr.toLowerCase();
      for (const item of items) {
        if (!lowerBody.includes(String(item).toLowerCase())) {
          throw new Error(`Response does not contain expected text: "${item}"`);
        }
      }
    }

    if (expect.notContains) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      const items = Array.isArray(expect.notContains) ? expect.notContains : [expect.notContains];
      const lowerBody = bodyStr.toLowerCase();
      for (const item of items) {
        if (lowerBody.includes(String(item).toLowerCase())) {
          throw new Error(`Response contains unexpected text: "${item}"`);
        }
      }
    }

    if (expect.piiRedacted === true) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      const piiPatterns = [
        /\d{3}-\d{2}-\d{4}/,
        /\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}/,
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
      ];

      for (const pattern of piiPatterns) {
        if (pattern.test(bodyStr)) {
          spinner.clear();
          Logger.warn('Warning: Potential unredacted PII found in response');
          spinner.render();
        }
      }
    }

    if (expect.reason) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      if (!bodyStr.toLowerCase().includes(expect.reason.toLowerCase())) {
        throw new Error(`Response does not contain expected reason: "${expect.reason}"`);
      }
    }

    if (expect.mcpResult) {
      const result = typeof body === 'object' ? body : JSON.parse(body);
      if (!result.result) {
        throw new Error('MCP response missing result field');
      }

      if (expect.mcpResult.tools) {
        const tools = result.result.tools || [];
        for (const expectedTool of expect.mcpResult.tools) {
          const found = tools.some(t => t.name === expectedTool);
          if (!found) {
            throw new Error(`Expected MCP tool '${expectedTool}' not found in response`);
          }
        }
      }

      if (expect.mcpResult.content) {
        const content = result.result.content || [];
        const contentText = content
          .map(c => c.text || '')
          .join(' ')
          .toLowerCase();
        for (const expectedContent of expect.mcpResult.content) {
          if (!contentText.includes(expectedContent.toLowerCase())) {
            throw new Error(`Expected content '${expectedContent}' not found in MCP response`);
          }
        }
      }
    }

    if (expect.headers) {
      const respHeaders = response.headers || {};
      for (const [key, expectedValue] of Object.entries(expect.headers)) {
        const actualValue = respHeaders[key.toLowerCase()];
        if (actualValue === undefined) {
          throw new Error(`Expected header '${key}' not found in response`);
        }
        if (expectedValue !== '*' && actualValue !== expectedValue) {
          throw new Error(`Header '${key}': expected '${expectedValue}', got '${actualValue}'`);
        }
      }
    }

    if (expect['content-type']) {
      const expectedType = expect['content-type'];
      const actualType = response.headers?.['content-type'] || '';
      if (!actualType.includes(expectedType)) {
        throw new Error(`Expected content-type "${expectedType}" but got "${actualType}"`);
      }
    }

    if (expect.body === 'non-empty') {
      if (!body || body.length === 0) {
        throw new Error('Expected non-empty response body');
      }
    }
  }

  /**
   * Start a port-forward process with proper error handling
   * @param {string} namespace - K8s namespace
   * @param {string} service - Service name
   * @param {number} localPort - Local port
   * @param {number} remotePort - Remote port
   * @param {string} actionName - Action name for error messages
   * @returns {Promise<{process: ChildProcess, cleanup: () => Promise<void>}>}
   */
  static async startPortForward(namespace, service, localPort, remotePort, actionName) {
    let stderrOutput = '';
    const pfProc = spawn(
      'kubectl',
      ['port-forward', '-n', namespace, `svc/${service}`, `${localPort}:${remotePort}`],
      { stdio: 'pipe' }
    );

    pfProc.stderr.on('data', data => {
      stderrOutput += data.toString();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${actionName}: port-forward timed out`)),
        15000
      );
      pfProc.stdout.on('data', data => {
        if (data.toString().includes('Forwarding from')) {
          clearTimeout(timer);
          resolve();
        }
      });
      pfProc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      pfProc.on('close', code => {
        if (code !== null) {
          clearTimeout(timer);
          const detail = stderrOutput.trim() || `exit code ${code}`;
          reject(new Error(`${actionName}: port-forward failed: ${detail}`));
        }
      });
    });

    const cleanup = async () => {
      pfProc.kill();
      // Small delay to allow OS to release the port
      await new Promise(r => setTimeout(r, 100));
    };

    return { process: pfProc, cleanup };
  }

  /**
   * Get gateway address from Kubernetes service
   */
  static async getGatewayAddress(namespace, gatewayName = EDITION_GATEWAY_NAME.enterprise) {
    try {
      const result = await KubernetesHelper.kubectl(
        [
          'get',
          'svc',
          gatewayName,
          '-n',
          namespace,
          '-o',
          'jsonpath={.status.loadBalancer.ingress[0].ip}',
        ],
        { ignoreError: true }
      );

      let address = (result.stdout || '').trim();

      if (!address) {
        const hostnameResult = await KubernetesHelper.kubectl(
          [
            'get',
            'svc',
            gatewayName,
            '-n',
            namespace,
            '-o',
            'jsonpath={.status.loadBalancer.ingress[0].hostname}',
          ],
          { ignoreError: true }
        );
        address = (hostnameResult.stdout || '').trim();
      }

      if (!address) {
        address = 'localhost';
      }

      return address;
    } catch {
      return 'localhost';
    }
  }
}
