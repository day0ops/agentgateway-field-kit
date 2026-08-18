import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { policyApiVersion, POLICY_KIND } from '../../src/lib/editions.js';

/**
 * MCP Guardrails Feature
 *
 * Deploys the ext-mcp-guardrail gRPC server (github.com/day0ops/ext-mcp-guardrail)
 * and wires it into an MCP backend's guardrails policy (spec.backend.mcp.guardrails),
 * an EnterpriseAgentgatewayPolicy-only capability - no OSS equivalent exists.
 *
 * The server implements agentgateway's ExtMCP protocol over plaintext gRPC (h2c):
 *   - CheckRequest:  denies tools/call to any tool name on DENIED_TOOLS
 *   - CheckResponse: masks PII (email/phone/SSN/credit card) in tools/call results
 *
 * Reference: https://docs.solo.io/agentgateway/2026.7.1/mcp/guardrails/setup/
 *
 * Configuration:
 * {
 *   image: string,             // Container image (default: GAR ext-mcp-guardrail:0.1.0)
 *   imagePullPolicy: string,   // default: 'IfNotPresent'
 *   serverName: string,        // Deployment/Service/ServiceAccount name (default: 'ext-mcp-guardrail')
 *   port: number,              // Container/Service port (default: 4445)
 *   deniedTools: string,       // Comma-separated tool names -> DENIED_TOOLS env var (default: none denied)
 *   policyName: string,        // EnterpriseAgentgatewayPolicy name (default: 'mcp-guardrails')
 *   backendName: string,       // Backend to protect (required)
 *   backendKind: string,       // 'EnterpriseAgentgatewayBackend' (default) | 'AgentgatewayBackend'
 *   methods: Object,           // JSON-RPC method -> 'Request'|'Response'|'Full'|'Off' (default: { 'tools/call': 'Full' })
 *   failureMode: string,       // 'FailClosed' (default) | 'FailOpen'
 * }
 */
export class McpGuardrailsFeature extends Feature {
  // spec.backend.mcp.guardrails only exists on EnterpriseAgentgatewayPolicy, confirmed no OSS
  // equivalent exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.image =
      config.image ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/ext-mcp-guardrail:0.1.2';
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.serverName = config.serverName || 'ext-mcp-guardrail';
    this.port = config.port || 4445;
    this.deniedTools = config.deniedTools || '';

    this.policyName = config.policyName || 'mcp-guardrails';
    this.backendName = config.backendName;
    this.backendKind = config.backendKind || 'EnterpriseAgentgatewayBackend';
    this.methods = config.methods || { 'tools/call': 'Full' };
    this.failureMode = config.failureMode || 'FailClosed';
  }

  validate() {
    if (!this.backendName) {
      throw new Error('mcp-guardrails requires backendName (the MCP backend to protect)');
    }

    const validKinds = ['AgentgatewayBackend', 'EnterpriseAgentgatewayBackend'];
    if (!validKinds.includes(this.backendKind)) {
      throw new Error(`backendKind must be one of: ${validKinds.join(', ')}`);
    }

    const validFailureModes = ['FailClosed', 'FailOpen'];
    if (!validFailureModes.includes(this.failureMode)) {
      throw new Error(`failureMode must be one of: ${validFailureModes.join(', ')}`);
    }

    const validMethodValues = ['Request', 'Response', 'Full', 'Off'];
    for (const [method, value] of Object.entries(this.methods)) {
      if (!validMethodValues.includes(value)) {
        throw new Error(`methods['${method}'] must be one of: ${validMethodValues.join(', ')}`);
      }
    }

    return true;
  }

  get backendGroup() {
    return this.backendKind === 'EnterpriseAgentgatewayBackend'
      ? 'enterpriseagentgateway.solo.io'
      : 'agentgateway.dev';
  }

  labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentgateway-demo',
      'agentgateway.dev/feature': this.name,
    };
  }

  async deploy() {
    await this.deployServer();
    await this.deployGuardrailPolicy();
  }

  async deployServer() {
    await this.applyResource({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: this.labels(),
      },
    });

    await this.applyResource({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { ...this.labels(), app: this.serverName },
      },
      spec: {
        selector: { app: this.serverName },
        ports: [
          {
            port: this.port,
            targetPort: this.port,
            // ExtMCP is plaintext gRPC (h2c) - see the docs reference above.
            appProtocol: 'kubernetes.io/h2c',
          },
        ],
      },
    });

    await this.applyResource({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { ...this.labels(), app: this.serverName },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.serverName } },
        template: {
          metadata: { labels: { app: this.serverName } },
          spec: {
            serviceAccountName: this.serverName,
            containers: [
              {
                name: 'server',
                image: this.image,
                imagePullPolicy: this.imagePullPolicy,
                ports: [{ containerPort: this.port }],
                env: [
                  { name: 'PORT', value: String(this.port) },
                  { name: 'DENIED_TOOLS', value: this.deniedTools },
                ],
                resources: {
                  requests: { memory: '64Mi', cpu: '50m' },
                  limits: { memory: '128Mi', cpu: '200m' },
                },
                // No HTTP endpoint to probe - the server only speaks gRPC - so use a
                // plain TCP check instead.
                readinessProbe: {
                  tcpSocket: { port: this.port },
                  initialDelaySeconds: 3,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: this.port },
                  initialDelaySeconds: 5,
                  periodSeconds: 30,
                },
              },
            ],
          },
        },
      },
    });

    this.log(`ext-mcp-guardrail server '${this.serverName}' deployed`, 'info');
  }

  async deployGuardrailPolicy() {
    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: this.labels(),
      },
      spec: {
        targetRefs: [
          {
            group: this.backendGroup,
            kind: this.backendKind,
            name: this.backendName,
          },
        ],
        backend: {
          mcp: {
            guardrails: {
              processors: [
                {
                  remote: {
                    backendRef: {
                      name: this.serverName,
                      port: this.port,
                    },
                    failureMode: this.failureMode,
                  },
                  methods: this.methods,
                },
              ],
            },
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(
      `Guardrail policy '${this.policyName}' applied to ${this.backendKind} '${this.backendName}'`,
      'info'
    );
  }

  async cleanup() {
    this.log('Cleaning up MCP guardrails feature...', 'info');
    await this.deleteResource(POLICY_KIND[this.edition], this.policyName);
    await this.deleteResource('Deployment', this.serverName);
    await this.deleteResource('Service', this.serverName);
    await this.deleteResource('ServiceAccount', this.serverName);
    this.log('MCP guardrails feature cleaned up', 'info');
  }
}
