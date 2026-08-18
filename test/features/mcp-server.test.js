import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

describe('McpServerFeature multiplexed targets', () => {
  test('targets[].tls sets policies.tls only on that target, not backend-wide', async () => {
    // Regression guard: the top-level `tls` option applies to every target on the
    // backend, which breaks a plaintext target multiplexed alongside an HTTPS one.
    // targets[].tls scopes the policy to just that target instead.
    const docs = await FeatureManager.deploy(
      'mcp-server',
      {
        namespace: 'agentgateway-system',
        deployServer: false,
        targets: [
          { name: 'plain', host: 'plain.svc.cluster.local', port: 80, protocol: 'StreamableHTTP' },
          {
            name: 'secure',
            host: 'secure.example.com',
            port: 443,
            protocol: 'StreamableHTTP',
            tls: { sni: 'secure.example.com' },
          },
        ],
      },
      { dryRun: true }
    );
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mcp-backend');
    const [plain, secure] = backend.spec.mcp.targets;
    expect(plain.static.policies).toBeUndefined();
    expect(secure.static.policies.tls).toEqual({ sni: 'secure.example.com' });
  });

  test('targets[].tls.insecureSkipVerify is validated the same way as the top-level option', async () => {
    await expect(
      FeatureManager.deploy(
        'mcp-server',
        {
          namespace: 'agentgateway-system',
          deployServer: false,
          targets: [
            {
              name: 'secure',
              host: 'secure.example.com',
              port: 443,
              protocol: 'StreamableHTTP',
              tls: { insecureSkipVerify: 'Nonsense' },
            },
          ],
        },
        {}
      )
    ).rejects.toThrow(/insecureSkipVerify must be one of/);
  });

  test('a target with both secretRef and tls gets both policies merged', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-server',
      {
        namespace: 'agentgateway-system',
        deployServer: false,
        targets: [
          {
            name: 'secure-auth',
            host: 'secure.example.com',
            port: 443,
            protocol: 'StreamableHTTP',
            tls: { sni: 'secure.example.com' },
            secretRef: { name: 'secure-auth-secret', envVar: 'SECURE_AUTH_TOKEN' },
          },
        ],
      },
      { dryRun: true }
    );
    const backend = findDoc(docs, 'EnterpriseAgentgatewayBackend', 'mcp-backend');
    const [target] = backend.spec.mcp.targets;
    expect(target.static.policies.tls).toEqual({ sni: 'secure.example.com' });
    expect(target.static.policies.auth).toEqual({ secretRef: { name: 'secure-auth-secret' } });
  });
});

describe('McpServerFeature CORS', () => {
  test('no CORS filter on the HTTPRoute by default', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-server',
      { namespace: 'agentgateway-system', deployServer: false },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp');
    expect(route.spec.rules[0].filters).toBeUndefined();
  });

  test('cors.enabled adds a CORS filter with sane defaults', async () => {
    // Regression guard: a browser-based MCP client (e.g. the MCP inspector) sends a
    // CORS preflight (OPTIONS) before the real request. Without this filter, a Strict
    // MCP auth policy 401s the preflight with no CORS headers and the browser blocks
    // the real request before it's ever sent - this filter must intercept OPTIONS at
    // the route level, before the backend auth policy ever sees it.
    const docs = await FeatureManager.deploy(
      'mcp-server',
      { namespace: 'agentgateway-system', deployServer: false, cors: { enabled: true } },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp');
    expect(route.spec.rules[0].filters).toEqual([
      {
        type: 'CORS',
        cors: {
          allowCredentials: true,
          allowHeaders: ['Origin', 'Authorization', 'Content-Type', 'mcp-protocol-version'],
          allowMethods: ['*'],
          allowOrigins: ['*'],
          exposeHeaders: ['Origin', 'X-HTTPRoute-Header'],
          maxAge: 86400,
        },
      },
    ]);
  });

  test('cors and pathRewrite filters coexist without clobbering each other', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-server',
      {
        namespace: 'agentgateway-system',
        deployServer: false,
        pathRewrite: '/',
        cors: { enabled: true },
      },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp');
    const types = route.spec.rules[0].filters.map(f => f.type);
    expect(types).toEqual(['URLRewrite', 'CORS']);
  });

  test('cors.allowOrigins overrides the wildcard default', async () => {
    const docs = await FeatureManager.deploy(
      'mcp-server',
      {
        namespace: 'agentgateway-system',
        deployServer: false,
        cors: { enabled: true, allowOrigins: ['http://localhost:6274'] },
      },
      { dryRun: true }
    );
    const route = findDoc(docs, 'HTTPRoute', 'mcp');
    expect(route.spec.rules[0].filters[0].cors.allowOrigins).toEqual(['http://localhost:6274']);
  });
});
