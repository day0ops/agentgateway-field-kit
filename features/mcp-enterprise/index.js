import { Feature, FeatureManager } from '../../src/lib/feature.js';

/**
 * MCP Enterprise Backend Feature
 *
 * Configures an EnterpriseAgentgatewayBackend (spec.entMcp) - the enterprise-only
 * advanced MCP backend surface. This is a distinct CRD kind/field from the base
 * `mcp-server` feature's AgentgatewayBackend.spec.mcp, which only supports plain
 * static/selector targets. entMcp additionally supports:
 *   - toolMode: how upstream tools are exposed to clients (Standard/Search/Code/CodeSearch)
 *   - static.openAPI: expose a REST API as MCP tools from an OpenAPI schema ConfigMap
 *   - custom targets: composable multi-step tool pipelines (http/mcp steps)
 *
 * References:
 *   https://docs.solo.io/agentgateway/2026.7.1/mcp/tool-mode/
 *   https://docs.solo.io/agentgateway/2026.7.1/mcp/openapi/
 *   https://docs.solo.io/agentgateway/2026.7.1/mcp/composable/
 *
 * Configuration:
 * {
 *   backendName: string,           // EnterpriseAgentgatewayBackend name (default: 'mcp-ent-backend')
 *   toolMode: string,              // 'Standard' | 'Search' | 'Code' | 'CodeSearch' (optional)
 *   codeMode: {                    // Only valid when toolMode is 'Code' or 'CodeSearch'
 *     timeout: string,              //   e.g. '7s'
 *     cpuTimeout: string,
 *   },
 *   sessionRouting: string,        // 'Stateful' | 'Stateless' (optional)
 *   prefixMode: string,            // 'Always' | 'Conditional' | 'Never' (optional)
 *   failureMode: string,           // 'FailClosed' | 'FailOpen' (optional)
 *   targets: Array<{
 *     name: string,
 *     // Static target:
 *     host: string,
 *     port: number,
 *     path: string,                //   Optional URL path override
 *     openAPI: {                   //   Expose this REST API's OpenAPI schema as MCP tools
 *       schemaConfigMapName: string, //     ConfigMap name (created if 'schema' is also given)
 *       schema: Object,              //     OpenAPI 3.0 document; written to the ConfigMap's data.schema key
 *     },
 *     // Dynamic target (mutually exclusive with host):
 *     matchLabels: Object,          //   e.g. { app: 'my-mcp-server' }
 *     // Composable target (mutually exclusive with host/matchLabels): passed through
 *     // verbatim as spec.entMcp.targets[].custom — see the CRD for the exact shape.
 *     custom: {
 *       description: string,
 *       inputSchema: Object,         //   JSON schema for the tool's call arguments
 *       steps: Array<{ name, http: {...} } | { name, mcp: {...} }>,
 *       output: string,              //   CEL expression combining step results into the tool result
 *     },
 *   }>,
 *   routeName: string,             // HTTPRoute name (default: 'mcp-ent')
 *   pathPrefix: string,            // Route path prefix (default: none — matches all paths)
 *   tls: {                         // Connect to static targets on this backend over TLS.
 *     sni: string,                  //   SNI hostname sent during the TLS handshake (optional)
 *     insecureSkipVerify: string,   //   'All' | 'Hostname' — skip certificate verification (demo/dev only)
 *   },
 *   auth: {                        // Static credential the backend attaches to upstream requests
 *     secretRef: { name: string, key: string },  //   Reference an existing Secret directly
 *     value: string,                //   Or a raw value - the feature creates the Secret
 *     valueEnvVar: string,          //   Or an env var holding the value - the feature creates the Secret
 *     secretName: string,           //   Secret name when created (default: '<backendName>-auth-secret')
 *     secretKey: string,            //   Secret key when created (default: 'token')
 *     header: string,               //   Required - header name the credential is sent on
 *   },
 *   wellKnownPaths: boolean,       // Also match /.well-known/oauth-protected-resource<pathPrefix>
 *                                  // and /.well-known/oauth-authorization-server<pathPrefix> on the
 *                                  // HTTPRoute (default: false — only useful with a non-catch-all pathPrefix)
 * }
 */
export class McpEnterpriseFeature extends Feature {
  // EnterpriseAgentgatewayBackend/entMcp is an enterprise-only CRD kind, no OSS equivalent exists.
  static SUPPORTED_EDITIONS = ['enterprise'];

  constructor(name, config) {
    super(name, config);

    this.backendName = config.backendName || 'mcp-ent-backend';
    this.toolMode = config.toolMode || null;
    this.codeMode = config.codeMode || null;
    this.sessionRouting = config.sessionRouting || null;
    this.prefixMode = config.prefixMode || null;
    this.failureMode = config.failureMode || null;
    this.targets = config.targets || [];

    this.routeName = config.routeName || 'mcp-ent';
    this.pathPrefix = config.pathPrefix || null;
    this.tls = config.tls || null;
    this.auth = config.auth || null;
    this.wellKnownPaths = !!config.wellKnownPaths;
  }

  get authValue() {
    if (!this.auth) return null;
    return this.auth.value || (this.auth.valueEnvVar ? process.env[this.auth.valueEnvVar] : null);
  }

  get authSecretName() {
    return this.auth?.secretName || `${this.backendName}-auth-secret`;
  }

  get authSecretKey() {
    return this.auth?.secretKey || 'token';
  }

  get authSecretRef() {
    return this.auth?.secretRef || { name: this.authSecretName, key: this.authSecretKey };
  }

  validate() {
    const validToolModes = ['Standard', 'Search', 'Code', 'CodeSearch'];
    if (this.toolMode && !validToolModes.includes(this.toolMode)) {
      throw new Error(`toolMode must be one of: ${validToolModes.join(', ')}`);
    }
    if (this.codeMode && !['Code', 'CodeSearch'].includes(this.toolMode)) {
      throw new Error("codeMode may only be set when toolMode is 'Code' or 'CodeSearch'");
    }

    const validSessionRouting = ['Stateful', 'Stateless'];
    if (this.sessionRouting && !validSessionRouting.includes(this.sessionRouting)) {
      throw new Error(`sessionRouting must be one of: ${validSessionRouting.join(', ')}`);
    }

    const validPrefixMode = ['Always', 'Conditional', 'Never'];
    if (this.prefixMode && !validPrefixMode.includes(this.prefixMode)) {
      throw new Error(`prefixMode must be one of: ${validPrefixMode.join(', ')}`);
    }

    const validFailureMode = ['FailClosed', 'FailOpen'];
    if (this.failureMode && !validFailureMode.includes(this.failureMode)) {
      throw new Error(`failureMode must be one of: ${validFailureMode.join(', ')}`);
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

    if (this.auth) {
      if (!this.auth.header) {
        throw new Error('auth requires header');
      }
      if (!this.auth.secretRef && !this.authValue) {
        throw new Error('auth requires secretRef, or value/valueEnvVar');
      }
    }

    if (this.targets.length === 0) {
      throw new Error('mcp-enterprise requires at least one target');
    }
    for (const t of this.targets) {
      if (!t.name) {
        throw new Error('Each target must have a name');
      }
      const kinds = [!!t.matchLabels, !!t.host, !!t.custom];
      if (kinds.filter(Boolean).length !== 1) {
        throw new Error(
          `Target '${t.name}' must have exactly one of 'host' (static), 'matchLabels' (dynamic), or 'custom' (composable)`
        );
      }
    }

    return true;
  }

  buildTarget(t) {
    if (t.custom) {
      return {
        name: t.name,
        custom: t.custom,
      };
    }
    if (t.matchLabels) {
      return {
        name: t.name,
        selector: {
          services: { matchLabels: t.matchLabels },
        },
      };
    }
    return {
      name: t.name,
      static: {
        host: t.host,
        port: t.port,
        ...(t.path && { path: t.path }),
        ...(t.openAPI && {
          protocol: 'OpenAPI',
          openAPI: { schemaRef: { name: t.openAPI.schemaConfigMapName } },
        }),
      },
    };
  }

  async deploy() {
    for (const t of this.targets) {
      if (t.openAPI?.schema) {
        await this.createOpenApiConfigMap(t.openAPI);
      }
    }

    const targets = this.targets.map(t => this.buildTarget(t));

    const backend = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBackend',
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      spec: {
        entMcp: {
          targets,
          ...(this.toolMode && { toolMode: this.toolMode }),
          ...(this.codeMode && { codeMode: this.codeMode }),
          ...(this.sessionRouting && { sessionRouting: this.sessionRouting }),
          ...(this.prefixMode && { prefixMode: this.prefixMode }),
          ...(this.failureMode && { failureMode: this.failureMode }),
        },
        ...(this.auth && {
          policies: {
            auth: {
              secretRef: this.authSecretRef,
              location: { header: { name: this.auth.header } },
            },
          },
        }),
      },
    };

    if (this.auth && !this.auth.secretRef) {
      await this.deployAuthSecret();
    }

    await this.applyResource(backend);
    this.log(
      `EnterpriseAgentgatewayBackend '${this.backendName}' created with ${targets.length} target(s)`,
      'info'
    );

    if (this.tls) {
      await this.deployBackendTlsPolicy();
    }
    await this.deployHTTPRoute();
  }

  async deployAuthSecret() {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.authSecretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      type: 'Opaque',
      stringData: {
        [this.authSecretKey]: this.dryRun ? '<set auth.value>' : this.authValue,
      },
    };
    await this.applyResource(secret);
  }

  async createOpenApiConfigMap({ schemaConfigMapName, schema }) {
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: schemaConfigMapName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentgateway-demo',
          'agentgateway.dev/feature': this.name,
        },
      },
      data: {
        schema: JSON.stringify(schema),
      },
    };

    await this.applyResource(configMap);
    this.log(`ConfigMap '${schemaConfigMapName}' created with OpenAPI schema`, 'info');
  }

  get tlsPolicyName() {
    return `${this.backendName}-tls`;
  }

  async deployBackendTlsPolicy() {
    this.log(`Applying backend TLS policy '${this.tlsPolicyName}'...`, 'info');

    const policy = {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
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
            group: 'enterpriseagentgateway.solo.io',
            kind: 'EnterpriseAgentgatewayBackend',
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
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayBackend',
        },
      ],
    };

    if (this.pathPrefix) {
      rule.matches = [{ path: { type: 'PathPrefix', value: this.pathPrefix } }];
      if (this.wellKnownPaths) {
        rule.matches.push(
          {
            path: {
              type: 'PathPrefix',
              value: `/.well-known/oauth-protected-resource${this.pathPrefix}`,
            },
          },
          {
            path: {
              type: 'PathPrefix',
              value: `/.well-known/oauth-authorization-server${this.pathPrefix}`,
            },
          }
        );
      }
    }

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
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

    await this.applyResource(route);
    const pathMsg = this.pathPrefix ? ` at ${this.pathPrefix}` : '';
    this.log(`HTTPRoute '${this.routeName}' created${pathMsg}`, 'info');
  }

  async cleanup() {
    this.log('Cleaning up MCP enterprise backend feature...', 'info');
    await this.deleteResource('HTTPRoute', this.routeName);
    if (this.tls) {
      await this.deleteResource('EnterpriseAgentgatewayPolicy', this.tlsPolicyName);
    }
    await this.deleteResource('EnterpriseAgentgatewayBackend', this.backendName);
    if (this.auth && !this.auth.secretRef) {
      await this.deleteResource('Secret', this.authSecretName);
    }
    for (const t of this.targets) {
      if (t.openAPI?.schema) {
        await this.deleteResource('ConfigMap', t.openAPI.schemaConfigMapName);
      }
    }
    this.log('MCP enterprise backend feature cleaned up', 'info');
  }
}
