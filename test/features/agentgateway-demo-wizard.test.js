import { test, expect, describe } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

function findDoc(docs, kind, name) {
  return docs.map(d => yaml.load(d)).find(d => d.kind === kind && d.metadata.name === name);
}

const ORIGINAL_ENV = { ...process.env };
function withEnv(vars, fn) {
  Object.assign(process.env, vars);
  return fn().finally(() => {
    process.env = { ...ORIGINAL_ENV };
  });
}

describe('AgentgatewayDemoWizardFeature', () => {
  test('deploys RBAC scoped to exactly the verbs/resources the wizard documents', () =>
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
        DEMO_USER_PASSWORD: 'Password1!',
      },
      async () => {
        const docs = await FeatureManager.deploy(
          'agentgateway-demo-wizard',
          { namespace: 'agentgateway-system' },
          { dryRun: true }
        );

        const role = findDoc(docs, 'Role', 'agentgateway-demo-wizard');
        expect(role).toBeTruthy();
        const resources = role.rules.flatMap(r => r.resources);
        expect(resources.sort()).toEqual(
          [
            'gateways',
            'httproutes',
            'enterpriseagentgatewaybackends',
            'enterpriseagentgatewaypolicies',
            'enterpriseagentgatewayparameters',
            'enterpriseagentgatewaybudgets',
            'ratelimitconfigs',
            'configmaps',
            'secrets',
            'services',
            'serviceaccounts',
            'deployments',
          ].sort()
        );
        for (const rule of role.rules) {
          expect(rule.verbs.sort()).toEqual(
            ['get', 'list', 'watch', 'create', 'patch', 'delete'].sort()
          );
        }

        expect(findDoc(docs, 'ServiceAccount', 'agentgateway-demo-wizard')).toBeTruthy();
        const rb = findDoc(docs, 'RoleBinding', 'agentgateway-demo-wizard');
        expect(rb.roleRef.name).toBe('agentgateway-demo-wizard');
        expect(rb.subjects[0].name).toBe('agentgateway-demo-wizard');
      }
    ));

  test('wires the image and host env vars into the Deployment, and secret env vars via envFrom', () =>
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
        DEMO_USER_PASSWORD: 'Password1!',
      },
      async () => {
        const docs = await FeatureManager.deploy(
          'agentgateway-demo-wizard',
          {
            namespace: 'agentgateway-system',
            image: 'example.com/agentgateway-demo-wizard:v0.1.0',
            agwHost: 'agentgateway.demo.example.com',
            keycloakHost: 'keycloak.demo.example.com',
          },
          { dryRun: true }
        );

        const deployment = findDoc(docs, 'Deployment', 'agentgateway-demo-wizard');
        const container = deployment.spec.template.spec.containers[0];
        expect(container.image).toBe('example.com/agentgateway-demo-wizard:v0.1.0');
        expect(container.env).toContainEqual({
          name: 'AGW_HOST',
          value: 'agentgateway.demo.example.com',
        });
        expect(container.env).toContainEqual({
          name: 'KEYCLOAK_HOST',
          value: 'keycloak.demo.example.com',
        });
        expect(container.envFrom).toContainEqual({
          secretRef: { name: 'agentgateway-demo-wizard-env' },
        });
        expect(deployment.spec.template.spec.serviceAccountName).toBe('agentgateway-demo-wizard');

        const secret = findDoc(docs, 'Secret', 'agentgateway-demo-wizard-env');
        expect(secret.stringData.OPENAI_API_KEY).toBe('<set OPENAI_API_KEY>');
        expect(secret.stringData.DEMO_USER_PASSWORD).toBe('Password1!');

        expect(findDoc(docs, 'Service', 'agentgateway-demo-wizard')).toBeTruthy();
      }
    ));

  test('DEMO_USER_PASSWORD defaults to Password1! when unset', () =>
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
        DEMO_USER_PASSWORD: '',
      },
      async () => {
        const docs = await FeatureManager.deploy(
          'agentgateway-demo-wizard',
          { namespace: 'agentgateway-system' },
          { dryRun: true }
        );
        const secret = findDoc(docs, 'Secret', 'agentgateway-demo-wizard-env');
        expect(secret.stringData.DEMO_USER_PASSWORD).toBe('Password1!');
      }
    ));

  test('validate() throws when a required secret env var is missing', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        FeatureManager.deploy('agentgateway-demo-wizard', { namespace: 'agentgateway-system' }, {})
      ).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    }
  });

  test('bundles the routing-dynamic HTTPRoute, header-matched to the two tier backends', () =>
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
        DEMO_USER_PASSWORD: 'Password1!',
      },
      async () => {
        const docs = await FeatureManager.deploy(
          'agentgateway-demo-wizard',
          { namespace: 'agentgateway-system' },
          { dryRun: true }
        );
        const route = findDoc(docs, 'HTTPRoute', 'routing-dynamic');
        expect(route).toBeTruthy();
        expect(route.spec.parentRefs[0].name).toBe('agentgateway-gw');
        const backendNames = route.spec.rules.flatMap(r => r.backendRefs.map(b => b.name));
        expect(backendNames.sort()).toEqual(
          ['routing-dynamic-fast', 'routing-dynamic-premium'].sort()
        );
      }
    ));

  test('applies a dedicated HTTPS Gateway+Certificate+Route with VPN sourceRanges when hostname+tls are set', () =>
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
        DEMO_USER_PASSWORD: 'Password1!',
      },
      async () => {
        const docs = await FeatureManager.deploy(
          'agentgateway-demo-wizard',
          {
            namespace: 'agentgateway-system',
            hostname: 'wizard.demo.example.com',
            tls: { enabled: true, issuer: 'letsencrypt-dns' },
            sourceRanges: ['165.99.148.61/32'],
          },
          { dryRun: true }
        );

        const gateway = findDoc(docs, 'Gateway', 'agentgateway-demo-wizard-https');
        expect(gateway.spec.listeners[0].hostname).toBe('wizard.demo.example.com');
        expect(
          gateway.spec.infrastructure.annotations[
            'service.beta.kubernetes.io/load-balancer-source-ranges'
          ]
        ).toBe('165.99.148.61/32');

        const cert = findDoc(docs, 'Certificate', 'agentgateway-demo-wizard-tls');
        expect(cert.spec.dnsNames).toEqual(['wizard.demo.example.com']);

        const route = findDoc(docs, 'HTTPRoute', 'agentgateway-demo-wizard');
        expect(route.spec.hostnames).toEqual(['wizard.demo.example.com']);
        expect(route.spec.rules[0].backendRefs[0].name).toBe('agentgateway-demo-wizard');
      }
    ));

  test('skips the dedicated Gateway/Certificate/Route entirely when hostname is unset (local/dev)', () =>
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
        DEMO_USER_PASSWORD: 'Password1!',
      },
      async () => {
        const docs = await FeatureManager.deploy(
          'agentgateway-demo-wizard',
          { namespace: 'agentgateway-system' },
          { dryRun: true }
        );
        expect(findDoc(docs, 'Gateway', 'agentgateway-demo-wizard-https')).toBeFalsy();
        expect(findDoc(docs, 'HTTPRoute', 'agentgateway-demo-wizard')).toBeFalsy();
      }
    ));
});
