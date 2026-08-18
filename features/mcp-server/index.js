import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import {
  policyApiVersion,
  POLICY_KIND,
  BACKEND_API_GROUP,
  BACKEND_KIND,
} from '../../src/lib/editions.js';

/**
 * MCP Server Feature
 *
 * Configures an MCP (Model Context Protocol) server backend and routes
 * traffic through agentgateway. Supports both static and dynamic (label-selector)
 * target discovery. Optionally deploys the MCP server workload.
 *
 * References:
 *   Static:  https://docs.solo.io/agentgateway/latest/mcp/static-mcp/
 *   Dynamic: https://docs.solo.io/agentgateway/latest/mcp/dynamic-mcp/
 *
 * This feature:
 * - Optionally deploys an MCP server workload (Deployment, Service, ServiceAccount)
 * - Creates the Service with `appProtocol: kgateway.dev/mcp`
 * - Creates a Backend with `spec.mcp.targets` for MCP routing - AgentgatewayBackend on
 *   opensource, EnterpriseAgentgatewayBackend on enterprise (same `spec.mcp` shape, plus
 *   enterprise-only `failureMode`/`prefixMode` - see BACKEND_KIND/BACKEND_API_GROUP in
 *   src/lib/editions.js, same dual-edition pattern as the mock-provider feature)
 *   - Static targets: explicit host/port/protocol
 *   - Dynamic targets: Kubernetes label selectors (Streamable HTTP only)
 * - Creates an HTTPRoute that routes to the MCP backend
 *
 * Configuration:
 * {
 *   deployServer: boolean,         // Deploy the MCP server workload (default: true)
 *   image: string,                 // Container image (default: GAR stock-server-mcp:0.1.1)
 *   imagePullPolicy: string,       // Image pull policy (default: 'IfNotPresent')
 *   serverName: string,            // Server/app name (default: 'mcp-stock-server')
 *   serverPort: number,            // Container port the MCP server listens on (default: 8000)
 *   servicePort: number,           // Service port exposed to the cluster (default: 80)
 *   protocol: string,              // MCP transport: 'SSE' or 'StreamableHTTP' (default: 'SSE')
 *   mcpPath: string,               // Path the deployed server actually listens on, e.g. '/mcp' -
 *                                  //   sets the kgateway.dev/mcp-path Service annotation (read by
 *                                  //   dynamic/selector targets) AND the single-default-target's
 *                                  //   own static.path (static targets don't consult the Service
 *                                  //   annotation, so this is the only thing that affects them)
 *   env: Object,                   // Container environment variables as key-value pairs
 *                                  //   e.g. { MCP_TRANSPORT: 'streamable-http' }
 *   backendName: string,           // Backend resource name (default: 'mcp-backend')
 *   targetName: string,            // Target name inside the backend (default: 'mcp-target')
 *   matchLabels: Object,           // Dynamic discovery: label selector for MCP services
 *                                  //   e.g. { app: 'my-mcp-server' }
 *                                  //   When set, creates a selector-based target instead of static
 *                                  //   Note: only Streamable HTTP is supported for selectors
 *   targets: Array<{              // Multiple MCP targets (overrides single-server defaults)
 *     name: string,
 *     // Static target fields:
 *     host: string,
 *     port: number,
 *     protocol: string,
 *     path: string,                //   Optional URL path override (e.g. '/mcp/' for a remote server)
 *     secretRef: {                 //   Optional: inject an Authorization header from a Secret.
 *       name: string,               //     Secret name to create/reference
 *       envVar: string,             //     Env var this feature reads the token from
 *     },
 *     tls: {                       //   Optional: connect to this target only over TLS - use this
 *       sni: string,                //     (not the top-level `tls` option) when multiplexing a
 *       insecureSkipVerify: string, //     plaintext target alongside an HTTPS one on one backend,
 *     },                            //     since the top-level option applies to every target.
 *     // Dynamic target fields (mutually exclusive with host):
 *     matchLabels: Object,         //   e.g. { app: 'my-mcp-server' }
 *   }>,
 *   servers: Array<{              // Multiple server workloads to deploy (multiplex pattern)
 *     name: string,                //   Server/app name
 *     image: string,               //   Container image
 *     imagePullPolicy: string,     //   Image pull policy (default: 'IfNotPresent')
 *     serverPort: number,          //   Container port (default: 8000)
 *     servicePort: number,         //   Service port (default: 80)
 *     mcpPath: string,             //   Optional kgateway.dev/mcp-path annotation
 *     env: Object,                 //   Container env vars as key-value pairs
 *   }>,
 *   routeName: string,             // HTTPRoute name (default: 'mcp')
 *   pathPrefix: string,            // Route path prefix (default: none — matches all paths)
 *   pathRewrite: string | null,   // Replace path prefix with this before forwarding (e.g. '/'); null = no rewrite
 *   sessionRouting: string,        // 'Stateful' (default) | 'Stateless' — MCP session affinity across replicas.
 *                                  //   Reference: https://docs.solo.io/agentgateway/2026.7.1/mcp/session/
 *   failureMode: string,           // Enterprise-only: 'FailClosed' | 'FailOpen' - behavior when a
 *                                  //   multiplexed target is unreachable (ignored on opensource,
 *                                  //   whose CRD doesn't have this field)
 *   prefixMode: string,            // Enterprise-only: 'Always' | 'Conditional' | 'Never' - whether
 *                                  //   tool names get prefixed by target name when multiplexing
 *                                  //   (ignored on opensource, whose CRD doesn't have this field)
 *   tls: {                         // Connect to the backend MCP server(s) over TLS (e.g. a remote HTTPS server).
 *                                  //   Applies to every static target on this backend - use
 *                                  //   targets[].tls instead when multiplexing targets that need
 *                                  //   different TLS settings (e.g. one plaintext, one HTTPS).
 *                                  //   Reference: https://docs.solo.io/agentgateway/2026.7.1/mcp/https/
 *     sni: string,                 // SNI hostname sent during the TLS handshake (optional)
 *     insecureSkipVerify: string,  // 'All' | 'Hostname' — skip certificate verification (demo/dev only)
 *   },
 *   cors: {                        // Off by default - opt in for browser-based MCP clients (e.g. the
 *                                  //   MCP inspector), which send a CORS preflight (OPTIONS) that a
 *                                  //   Strict MCP auth policy would otherwise 401 with no CORS headers,
 *                                  //   causing the browser to block the real request before it's sent.
 *     enabled: boolean,            // Default: false
 *     allowOrigins: string[],      // Default: ['*']
 *     allowMethods: string[],      // Default: ['*']
 *     allowHeaders: string[],      // Default: ['Origin', 'Authorization', 'Content-Type', 'mcp-protocol-version']
 *     exposeHeaders: string[],     // Default: ['Origin', 'X-HTTPRoute-Header']
 *     maxAge: number,              // Default: 86400
 *   },
 * }
 */
export class McpServerFeature extends Feature {
  constructor(name, config) {
    super(name, config);

    this.shouldDeployServer = config.deployServer !== false;
    this.image =
      config.image ||
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/stock-server-mcp:0.1.1';
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.serverName = config.serverName || 'mcp-stock-server';
    this.serverPort = config.serverPort || 8000;
    this.servicePort = config.servicePort || 80;
    this.protocol = config.protocol || 'SSE';
    this.mcpPath = config.mcpPath || null;

    this.backendName = config.backendName || 'mcp-backend';
    this.targetName = config.targetName || 'mcp-target';
    this.targets = config.targets || null;
    this.matchLabels = config.matchLabels || null;
    this.env = config.env || null;
    this.servers = config.servers || null;

    this.routeName = config.routeName || 'mcp';
    this.pathPrefix = config.pathPrefix || null;
    this.pathRewrite = config.pathRewrite !== undefined ? config.pathRewrite : null;
    this.sessionRouting = config.sessionRouting || null;
    this.failureMode = config.failureMode || null;
    this.prefixMode = config.prefixMode || null;
    this.tls = config.tls || null;

    // Off by default: most MCP clients (Claude Desktop, VS Code, CLI tools) aren't
    // subject to browser CORS at all. Browser-based clients (e.g. the MCP inspector)
    // send a preflight OPTIONS before the real request, and the Strict MCP auth
    // policy 401s that preflight with no CORS headers - the browser then blocks the
    // real request before it's ever sent. Opt in per usecase where that matters.
    const cors = config.cors || {};
    this.corsEnabled = cors.enabled === true;
    this.corsAllowOrigins = cors.allowOrigins || ['*'];
    this.corsAllowMethods = cors.allowMethods || ['*'];
    // mcp-protocol-version is required - the MCP inspector sends it on its discovery
    // preflight, and a 200 OPTIONS response that omits it from Allow-Headers still
    // gets the follow-up request blocked by the browser (confirmed against a live
    // deployment: the preflight itself returns 200, but without this header present
    // the real GET/POST never gets sent).
    this.corsAllowHeaders = cors.allowHeaders || [
      'Origin',
      'Authorization',
      'Content-Type',
      'mcp-protocol-version',
    ];
    this.corsExposeHeaders = cors.exposeHeaders || ['Origin', 'X-HTTPRoute-Header'];
    this.corsMaxAge = cors.maxAge || 86400;
  }

  get backendApiGroup() {
    return BACKEND_API_GROUP[this.edition];
  }

  get backendKind() {
    return BACKEND_KIND[this.edition];
  }

  getFeaturePath() {
    return 'mcp-server';
  }

  validate() {
    const validProtocols = ['SSE', 'StreamableHTTP'];
    if (!validProtocols.includes(this.protocol)) {
      throw new Error(`protocol must be one of: ${validProtocols.join(', ')}`);
    }

    const validSessionRouting = ['Stateful', 'Stateless'];
    if (this.sessionRouting && !validSessionRouting.includes(this.sessionRouting)) {
      throw new Error(`sessionRouting must be one of: ${validSessionRouting.join(', ')}`);
    }

    const validFailureMode = ['FailClosed', 'FailOpen'];
    if (this.failureMode && !validFailureMode.includes(this.failureMode)) {
      throw new Error(`failureMode must be one of: ${validFailureMode.join(', ')}`);
    }

    const validPrefixMode = ['Always', 'Conditional', 'Never'];
    if (this.prefixMode && !validPrefixMode.includes(this.prefixMode)) {
      throw new Error(`prefixMode must be one of: ${validPrefixMode.join(', ')}`);
    }

    if (this.tls) {
      const validInsecureSkipVerify = ['All', 'Hostname'];
      if (
        this.tls.insecureSkipVerify &&
        !validInsecureSkipVerify.includes(this.tls.insecureSkipVerify)
      ) {
        throw new Error(
          `tls.insecureSkipVerify must be one of: ${validInsecureSkipVerify.join(', ')}`
        );
      }
    }

    if (this.matchLabels && typeof this.matchLabels !== 'object') {
      throw new Error('matchLabels must be an object of key-value label pairs');
    }

    if (this.targets) {
      for (const t of this.targets) {
        if (!t.name) {
          throw new Error('Each MCP target must have a name');
        }
        const isSelector = !!t.matchLabels;
        const isStatic = !!t.host;
        if (!isSelector && !isStatic) {
          throw new Error(
            `Target '${t.name}' must have either 'host' (static) or 'matchLabels' (dynamic)`
          );
        }
        if (isSelector && isStatic) {
          throw new Error(`Target '${t.name}' cannot have both 'host' and 'matchLabels'`);
        }
        if (isStatic && t.protocol && !validProtocols.includes(t.protocol)) {
          throw new Error(
            `Target '${t.name}' protocol must be one of: ${validProtocols.join(', ')}`
          );
        }
        if (t.tls?.insecureSkipVerify) {
          const validInsecureSkipVerify = ['All', 'Hostname'];
          if (!validInsecureSkipVerify.includes(t.tls.insecureSkipVerify)) {
            throw new Error(
              `Target '${t.name}' tls.insecureSkipVerify must be one of: ${validInsecureSkipVerify.join(', ')}`
            );
          }
        }
      }
    }

    if (this.servers) {
      for (const s of this.servers) {
        if (!s.name) {
          throw new Error('Each server in the servers array must have a name');
        }
        if (!s.image) {
          throw new Error(`Server '${s.name}' must have an image`);
        }
      }
    }

    return true;
  }

  async deploy() {
    if (this.servers) {
      for (const server of this.servers) {
        await this.deployWorkloadFor(server);
      }
      if (!this.dryRun) {
        for (const server of this.servers) {
          await this.waitForWorkloadReady(server.name);
        }
      }
    } else if (this.shouldDeployServer) {
      await this.deployWorkload();
      if (!this.dryRun) {
        await this.waitForWorkloadReady(this.serverName);
      }
    }

    for (const t of this.targets || []) {
      if (t.secretRef) {
        await this.createTargetSecret(t.secretRef);
      }
    }

    await this.deployBackend();
    if (this.tls) {
      await this.deployBackendTlsPolicy();
    }
    await this.deployHTTPRoute();
  }

  async createTargetSecret({ name, envVar, key = 'Authorization' }) {
    if (this.dryRun) {
      const secret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'agentgateway-demo',
            'agentgateway.dev/feature': this.name,
          },
        },
        stringData: { [key]: `<set ${envVar}>` },
      };
      await this.applyResource(secret);
      return;
    }

    await KubernetesHelper.createSecretFromLiteral(
      this.namespace,
      name,
      key,
      process.env[envVar],
      this.spinner
    );
    this.log(`Created secret '${name}' from ${envVar}`, 'info');
  }

  async deployWorkload() {
    this.log(`Deploying MCP server workload '${this.serverName}'...`, 'info');

    const saOverrides = {
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
      },
    };
    await this.applyYamlFile('serviceaccount.yaml', saOverrides);

    const svcAnnotations = {};
    if (this.mcpPath) {
      svcAnnotations['kgateway.dev/mcp-path'] = this.mcpPath;
    }

    const svcOverrides = {
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        ...(Object.keys(svcAnnotations).length > 0 && { annotations: svcAnnotations }),
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: this.serverName,
        },
      },
      spec: {
        selector: { app: this.serverName },
        ports: [
          {
            port: this.servicePort,
            targetPort: this.serverPort,
            appProtocol: 'kgateway.dev/mcp',
          },
        ],
      },
    };
    await this.applyYamlFile('service.yaml', svcOverrides);

    const deployOverrides = {
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: this.serverName,
        },
      },
      spec: {
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
                ports: [{ containerPort: this.serverPort }],
                ...(this.env && {
                  env: Object.entries(this.env).map(([name, value]) => ({
                    name,
                    value: String(value),
                  })),
                }),
              },
            ],
          },
        },
      },
    };
    await this.applyYamlFile('deployment.yaml', deployOverrides);

    this.log(`MCP server '${this.serverName}' workload deployed`, 'info');
  }

  async deployWorkloadFor(server) {
    const name = server.name;
    const image = server.image;
    const imagePullPolicy = server.imagePullPolicy || this.imagePullPolicy;
    const serverPort = server.serverPort || this.serverPort;
    const servicePort = server.servicePort || this.servicePort;
    const mcpPath = server.mcpPath || this.mcpPath || null;
    const env = server.env || null;

    this.log(`Deploying MCP server workload '${name}'...`, 'info');

    const saOverrides = {
      metadata: {
        name,
        namespace: this.namespace,
      },
    };
    await this.applyYamlFile('serviceaccount.yaml', saOverrides);

    const svcAnnotations = {};
    if (mcpPath) {
      svcAnnotations['kgateway.dev/mcp-path'] = mcpPath;
    }

    const svcOverrides = {
      metadata: {
        name,
        namespace: this.namespace,
        ...(Object.keys(svcAnnotations).length > 0 && { annotations: svcAnnotations }),
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: name,
        },
      },
      spec: {
        selector: { app: name },
        ports: [
          {
            port: servicePort,
            targetPort: serverPort,
            appProtocol: 'kgateway.dev/mcp',
          },
        ],
      },
    };
    await this.applyYamlFile('service.yaml', svcOverrides);

    const deployOverrides = {
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
          app: name,
        },
      },
      spec: {
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            serviceAccountName: name,
            containers: [
              {
                name: 'server',
                image,
                imagePullPolicy,
                ports: [{ containerPort: serverPort }],
                ...(env && {
                  env: Object.entries(env).map(([k, value]) => ({
                    name: k,
                    value: String(value),
                  })),
                }),
              },
            ],
          },
        },
      },
    };
    await this.applyYamlFile('deployment.yaml', deployOverrides);

    this.log(`MCP server '${name}' workload deployed`, 'info');
  }

  async waitForWorkloadReady(name) {
    this.log(`Waiting for MCP server workload '${name}' to be ready...`, 'info');
    try {
      await KubernetesHelper.kubectl([
        'rollout',
        'status',
        `deployment/${name}`,
        '-n',
        this.namespace,
        '--timeout=120s',
      ]);
    } catch {
      this.log(`${name} rollout timed out (may still be pulling image)`, 'warn');
    }
  }

  buildTarget(t) {
    if (t.matchLabels) {
      return {
        name: t.name,
        selector: {
          services: { matchLabels: t.matchLabels },
        },
      };
    }
    const policies = {};
    if (t.secretRef) {
      policies.auth = { secretRef: { name: t.secretRef.name } };
    }
    if (t.tls) {
      policies.tls = {
        ...(t.tls.sni && { sni: t.tls.sni }),
        ...(t.tls.insecureSkipVerify && { insecureSkipVerify: t.tls.insecureSkipVerify }),
      };
    }

    return {
      name: t.name,
      static: {
        host: t.host,
        port: t.port || this.servicePort,
        protocol: t.protocol || this.protocol,
        ...(t.path && { path: t.path }),
        ...(Object.keys(policies).length > 0 && { policies }),
      },
    };
  }

  async deployBackend() {
    let targets;

    if (this.targets) {
      targets = this.targets.map(t => this.buildTarget(t));
    } else if (this.matchLabels) {
      targets = [
        {
          name: this.targetName,
          selector: {
            services: { matchLabels: this.matchLabels },
          },
        },
      ];
    } else {
      const serverHost = `${this.serverName}.${this.namespace}.svc.cluster.local`;
      targets = [
        {
          name: this.targetName,
          static: {
            host: serverHost,
            port: this.servicePort,
            protocol: this.protocol,
            // Static targets don't consult the Service's kgateway.dev/mcp-path annotation
            // (that's only read for dynamic/selector targets), so mcpPath must be threaded
            // in here directly or this single-default-target path silently forwards to
            // the server's root instead of wherever it actually listens.
            ...(this.mcpPath && { path: this.mcpPath }),
          },
        },
      ];
    }

    const overrides = {
      apiVersion: `${this.backendApiGroup}/v1alpha1`,
      kind: this.backendKind,
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        mcp: {
          targets,
          ...(this.sessionRouting && { sessionRouting: this.sessionRouting }),
          ...(this.failureMode && { failureMode: this.failureMode }),
          ...(this.prefixMode && { prefixMode: this.prefixMode }),
        },
      },
    };

    const isDynamic = targets.some(t => t.selector);
    const mode = isDynamic ? 'dynamic' : 'static';
    await this.applyYamlFile('backend.yaml', overrides);
    this.log(
      `${this.backendKind} '${this.backendName}' created with ${targets.length} ${mode} MCP target(s)`,
      'info'
    );
  }

  get tlsPolicyName() {
    return `${this.backendName}-tls`;
  }

  async deployBackendTlsPolicy() {
    this.log(`Applying backend TLS policy '${this.tlsPolicyName}'...`, 'info');

    const policy = {
      apiVersion: policyApiVersion(this.edition),
      kind: POLICY_KIND[this.edition],
      metadata: {
        name: this.tlsPolicyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          {
            group: this.backendApiGroup,
            kind: this.backendKind,
            name: this.backendName,
          },
        ],
        backend: {
          tls: {
            ...(this.tls.sni && { sni: this.tls.sni }),
            ...(this.tls.insecureSkipVerify && {
              insecureSkipVerify: this.tls.insecureSkipVerify,
            }),
          },
        },
      },
    };

    await this.applyResource(policy);
    this.log(`Backend TLS policy '${this.tlsPolicyName}' applied`, 'info');
  }

  async deployHTTPRoute() {
    const gatewayRef = FeatureManager.getGatewayRef();

    const rule = {
      backendRefs: [
        {
          name: this.backendName,
          group: this.backendApiGroup,
          kind: this.backendKind,
        },
      ],
    };

    if (this.pathPrefix) {
      rule.matches = [
        {
          path: {
            type: 'PathPrefix',
            value: this.pathPrefix,
          },
        },
      ];
    }

    const filters = [];
    if (this.pathRewrite != null) {
      filters.push({
        type: 'URLRewrite',
        urlRewrite: {
          path: { type: 'ReplacePrefixMatch', replacePrefixMatch: this.pathRewrite },
        },
      });
    }
    if (this.corsEnabled) {
      filters.push({
        type: 'CORS',
        cors: {
          allowCredentials: true,
          allowHeaders: this.corsAllowHeaders,
          allowMethods: this.corsAllowMethods,
          allowOrigins: this.corsAllowOrigins,
          exposeHeaders: this.corsExposeHeaders,
          maxAge: this.corsMaxAge,
        },
      });
    }
    if (filters.length > 0) {
      rule.filters = filters;
    }

    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        parentRefs: [
          {
            name: gatewayRef.name,
            namespace: gatewayRef.namespace,
          },
        ],
        rules: [rule],
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides);
    const pathMsg = this.pathPrefix ? ` at ${this.pathPrefix}` : '';
    const rewriteMsg = this.pathRewrite != null ? ` (rewrite → ${this.pathRewrite})` : '';
    this.log(`HTTPRoute '${this.routeName}' created${pathMsg}${rewriteMsg}`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up MCP server feature...', 'info');

    await this.deleteResource('HTTPRoute', this.routeName);
    if (this.tls) {
      await this.deleteResource(POLICY_KIND[this.edition], this.tlsPolicyName);
    }
    await this.deleteResource(this.backendKind, this.backendName);
    for (const t of this.targets || []) {
      if (t.secretRef) {
        await this.deleteResource('Secret', t.secretRef.name);
      }
    }

    if (this.servers) {
      for (const server of this.servers) {
        await this.deleteResource('Deployment', server.name);
        await this.deleteResource('Service', server.name);
        await this.deleteResource('ServiceAccount', server.name);
      }
    } else if (this.shouldDeployServer) {
      await this.deleteResource('Deployment', this.serverName);
      await this.deleteResource('Service', this.serverName);
      await this.deleteResource('ServiceAccount', this.serverName);
    }

    this.log('MCP server feature cleaned up', 'info');
  }
}
