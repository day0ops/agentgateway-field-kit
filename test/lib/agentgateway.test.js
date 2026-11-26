import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { AgentGatewayManager } from '../../src/lib/agentgateway.js';
import { KubernetesHelper } from '../../src/lib/common.js';

const ENTERPRISE_OCI = 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts';

describe('AgentGatewayManager.resolveVersionAndRegistry', () => {
  test('resolves enterprise defaults for a null profile (no --profile flag)', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry(null);
    expect(result.edition).toBe('enterprise');
    expect(result.ociRegistry).toBe(ENTERPRISE_OCI);
    expect(result.releaseName).toBe('enterprise-agentgateway');
    expect(result.chartName).toBe('enterprise-agentgateway');
    expect(result.crdsReleaseName).toBe('enterprise-agentgateway-crds');
    expect(result.crdsChartName).toBe('enterprise-agentgateway-crds');
  });

  test('a profile omitting spec.edition resolves byte-identically to a profile with edition: enterprise', () => {
    const withoutEdition = AgentGatewayManager.resolveVersionAndRegistry({});
    const withEnterprise = AgentGatewayManager.resolveVersionAndRegistry({ edition: 'enterprise' });
    expect(withoutEdition).toEqual(withEnterprise);
    expect(withoutEdition.edition).toBe('enterprise');
    expect(withoutEdition.ociRegistry).toBe(ENTERPRISE_OCI);
  });

  test('enterprise resolution matches the pre-edition hardcoded defaults exactly', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({});
    expect(result).toEqual({
      edition: 'enterprise',
      version: '2.1.1',
      ociRegistry: ENTERPRISE_OCI,
      gatewayApiVersion: 'v1.4.0',
      gatewayApiChannel: 'standard',
      crdsVersion: '2.1.1',
      crdsOciRegistry: ENTERPRISE_OCI,
      crdsHelmValues: null,
      releaseName: 'enterprise-agentgateway',
      chartName: 'enterprise-agentgateway',
      crdsReleaseName: 'enterprise-agentgateway-crds',
      crdsChartName: 'enterprise-agentgateway-crds',
    });
  });

  test('an explicit profile.agentgateway version/registry override wins regardless of edition', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({
      edition: 'enterprise',
      agentgateway: { version: '9.9.9', ociRegistry: 'oci://custom/charts' },
    });
    expect(result.version).toBe('9.9.9');
    expect(result.ociRegistry).toBe('oci://custom/charts');
  });

  test('edition: opensource resolves to the OSS chart base name and registry', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({ edition: 'opensource' });
    expect(result.edition).toBe('opensource');
    expect(result.ociRegistry).toBe('oci://cr.agentgateway.dev/charts');
    expect(result.releaseName).toBe('agentgateway-oss');
    expect(result.chartName).toBe('agentgateway');
    expect(result.crdsReleaseName).toBe('agentgateway-crds');
    expect(result.crdsChartName).toBe('agentgateway-crds');
  });

  test('an unrecognized edition value falls back to enterprise', () => {
    const result = AgentGatewayManager.resolveVersionAndRegistry({ edition: 'bogus' });
    expect(result.edition).toBe('enterprise');
  });
});

describe('AgentGatewayManager.buildDefaultGateway', () => {
  test('null profile resolves to enterprise name/namespace/gatewayClassName defaults', async () => {
    const gateway = await AgentGatewayManager.buildDefaultGateway(null, null);
    expect(gateway.metadata.name).toBe('agentgateway-gw');
    expect(gateway.metadata.namespace).toBe('agentgateway-system');
    expect(gateway.spec.gatewayClassName).toBe('enterprise-agentgateway');
    expect(gateway.spec.listeners).toHaveLength(1);
  });

  test('opensource edition resolves to its own Gateway name and GatewayClass default', async () => {
    const gateway = await AgentGatewayManager.buildDefaultGateway({ edition: 'opensource' }, null);
    expect(gateway.metadata.name).toBe('agentgateway-oss-gw');
    expect(gateway.spec.gatewayClassName).toBe('agentgateway');
  });

  test('a GatewayClass among profile.resources overrides the default gatewayClassName', async () => {
    const profile = {
      resources: [{ kind: 'GatewayClass', metadata: { name: 'my-custom-class' } }],
    };
    const gateway = await AgentGatewayManager.buildDefaultGateway(profile, null);
    expect(gateway.spec.gatewayClassName).toBe('my-custom-class');
  });

  test('profile.gateway.mtls.enabled adds an HTTPS listener and client-cert validation', async () => {
    const profile = { gateway: { mtls: { enabled: true, port: 8443 } } };
    const gateway = await AgentGatewayManager.buildDefaultGateway(profile, null);
    const httpsListener = gateway.spec.listeners.find(l => l.name === 'https');
    expect(httpsListener.port).toBe(8443);
    expect(httpsListener.tls.certificateRefs[0].name).toBe('gateway-mtls-server-tls');
    expect(gateway.spec.tls.frontend.default.validation.mode).toBe('AllowValidOnly');
  });

  test('profile.gateway.publicHttps.enabled adds a plain HTTPS listener with no client-cert requirement', async () => {
    const profile = { gateway: { publicHttps: { enabled: true, port: 8444 } } };
    const gateway = await AgentGatewayManager.buildDefaultGateway(profile, null);
    const publicListener = gateway.spec.listeners.find(l => l.name === 'https-public');
    expect(publicListener.port).toBe(8444);
    expect(gateway.spec.tls.frontend.perPort).toEqual([{ port: 8444, tls: {} }]);
  });

  test('an EnterpriseAgentgatewayParameters resource without sharedExtensions wires infrastructure.parametersRef', async () => {
    const profile = {
      resources: [
        { kind: 'EnterpriseAgentgatewayParameters', metadata: { name: 'gateway-params' } },
      ],
    };
    const gateway = await AgentGatewayManager.buildDefaultGateway(profile, null);
    expect(gateway.spec.infrastructure.parametersRef).toEqual({
      name: 'gateway-params',
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayParameters',
    });
  });
});

describe('AgentGatewayManager.installGatewayAPICRDs', () => {
  let originalKubectl, calls;

  beforeEach(() => {
    calls = [];
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
  });

  test('experimental channel clears the safe-upgrades VAP/binding before applying', async () => {
    await AgentGatewayManager.installGatewayAPICRDs('v1.6.3', 'experimental');

    expect(calls).toEqual([
      [
        'delete',
        'validatingadmissionpolicybinding',
        'safe-upgrades.gateway.networking.k8s.io',
        '--ignore-not-found',
      ],
      [
        'delete',
        'validatingadmissionpolicy',
        'safe-upgrades.gateway.networking.k8s.io',
        '--ignore-not-found',
      ],
      [
        'apply',
        '--server-side',
        '-f',
        'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/experimental-install.yaml',
      ],
    ]);
  });

  test('standard channel does not touch the safe-upgrades VAP/binding', async () => {
    await AgentGatewayManager.installGatewayAPICRDs('v1.4.0', 'standard');

    expect(calls).toEqual([
      [
        'apply',
        '--server-side',
        '-f',
        'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml',
      ],
    ]);
  });
});

describe('AgentGatewayManager.cleanupGatewayAPICRDs', () => {
  let originalKubectl, calls;

  beforeEach(() => {
    calls = [];
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'crd') {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: 'listenersets.gateway.networking.k8s.io',
                  annotations: { 'gateway.networking.k8s.io/bundle-version': 'v1.6.3' },
                },
              },
              {
                metadata: {
                  name: 'xbackends.gateway.networking.x-k8s.io',
                  annotations: { 'gateway.networking.k8s.io/bundle-version': 'v1.6.3' },
                },
              },
              { metadata: { name: 'certificates.cert-manager.io', annotations: {} } },
            ],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
  });

  test('deletes the safe-upgrades VAP/binding and only the CRDs carrying the bundle-version annotation', async () => {
    await AgentGatewayManager.cleanupGatewayAPICRDs();

    expect(calls).toEqual([
      [
        'delete',
        'validatingadmissionpolicybinding',
        'safe-upgrades.gateway.networking.k8s.io',
        '--ignore-not-found',
      ],
      [
        'delete',
        'validatingadmissionpolicy',
        'safe-upgrades.gateway.networking.k8s.io',
        '--ignore-not-found',
      ],
      ['get', 'crd', '-o', 'json'],
      [
        'delete',
        'crd',
        'listenersets.gateway.networking.k8s.io',
        'xbackends.gateway.networking.x-k8s.io',
        '--ignore-not-found',
      ],
    ]);
  });

  test('skips the delete crd call when no Gateway API CRDs are found', async () => {
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'crd') {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await AgentGatewayManager.cleanupGatewayAPICRDs();

    expect(calls.some(args => args[0] === 'delete' && args[1] === 'crd')).toBe(false);
  });
});

describe('AgentGatewayManager.cleanupAgentGatewayCRDs', () => {
  let originalKubectl, originalHelm, kubectlCalls, helmCalls;

  beforeEach(() => {
    kubectlCalls = [];
    helmCalls = [];
    originalKubectl = KubernetesHelper.kubectl;
    originalHelm = KubernetesHelper.helm;
    KubernetesHelper.helm = async args => {
      helmCalls.push(args);
      if (args[0] === 'list') {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
    KubernetesHelper.helm = originalHelm;
  });

  test('deletes CRDs by Helm ownership annotation even when no release is tracked in Helm', async () => {
    KubernetesHelper.kubectl = async args => {
      kubectlCalls.push(args);
      if (args[0] === 'get' && args[1] === 'crd') {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: 'enterpriseagentgatewayrbacpolicies.enterpriseagentgateway.solo.io',
                  annotations: { 'meta.helm.sh/release-name': 'enterprise-agentgateway-crds' },
                },
              },
              {
                metadata: {
                  name: 'certificates.cert-manager.io',
                  annotations: { 'meta.helm.sh/release-name': 'cert-manager' },
                },
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await AgentGatewayManager.cleanupAgentGatewayCRDs({
      version: '2.1.1',
      ociRegistry: 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts',
      chartName: 'enterprise-agentgateway-crds',
    });

    expect(helmCalls.some(args => args[0] === 'template')).toBe(false);
    expect(kubectlCalls).toContainEqual([
      'delete',
      'crd',
      'enterpriseagentgatewayrbacpolicies.enterpriseagentgateway.solo.io',
      '--ignore-not-found',
    ]);
  });

  test('falls back to helm template at the resolved version when no CRD carries the ownership annotation', async () => {
    KubernetesHelper.kubectl = async args => {
      kubectlCalls.push(args);
      if (args[0] === 'get' && args[1] === 'crd') {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    KubernetesHelper.helm = async args => {
      helmCalls.push(args);
      if (args[0] === 'list') {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'template') {
        return {
          stdout:
            'apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: enterpriseagentgatewayrbacpolicies.enterpriseagentgateway.solo.io\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await AgentGatewayManager.cleanupAgentGatewayCRDs({
      version: '2.1.1',
      ociRegistry: 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts',
      chartName: 'enterprise-agentgateway-crds',
    });

    const templateCall = helmCalls.find(args => args[0] === 'template');
    expect(templateCall).toEqual([
      'template',
      'agentgateway-crds-cleanup',
      'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts/enterprise-agentgateway-crds',
      '--version',
      '2.1.1',
      '--namespace',
      'agentgateway-system',
    ]);
    const deleteCall = kubectlCalls.find(args => args[0] === 'delete' && args.includes('-f'));
    expect(deleteCall).toBeDefined();
  });

  test('uninstalls the Helm release if one is still tracked, after CRD object cleanup', async () => {
    KubernetesHelper.kubectl = async args => {
      kubectlCalls.push(args);
      if (args[0] === 'get' && args[1] === 'crd') {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    KubernetesHelper.helm = async args => {
      helmCalls.push(args);
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify([{ name: 'enterprise-agentgateway-crds' }]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await AgentGatewayManager.cleanupAgentGatewayCRDs({});

    expect(helmCalls).toContainEqual([
      'uninstall',
      'enterprise-agentgateway-crds',
      '-n',
      'agentgateway-system',
      '--wait',
    ]);
  });
});
