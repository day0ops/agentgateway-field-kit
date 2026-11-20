import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import yaml from 'js-yaml';
import '../../features/index.js';
import { FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper } from '../../src/lib/common.js';

describe('GatewayFeature edition-aware defaults', () => {
  test('enterprise (default) uses agentgateway-gw and the enterprise GatewayClass', async () => {
    const docs = await FeatureManager.deploy('gateway', {}, { dryRun: true });
    const gateway = yaml.load(docs[0]);
    expect(gateway.metadata.name).toBe('agentgateway-gw');
    expect(gateway.spec.gatewayClassName).toBe('enterprise-agentgateway');
  });

  test('edition: opensource uses agentgateway-oss-gw and the OSS GatewayClass', async () => {
    const docs = await FeatureManager.deploy(
      'gateway',
      {},
      { dryRun: true, edition: 'opensource' }
    );
    const gateway = yaml.load(docs[0]);
    expect(gateway.metadata.name).toBe('agentgateway-oss-gw');
    expect(gateway.spec.gatewayClassName).toBe('agentgateway');
  });

  test('an explicit config.name/gatewayClassName still overrides the edition default', async () => {
    const docs = await FeatureManager.deploy(
      'gateway',
      { name: 'custom-gateway', gatewayClassName: 'custom-class' },
      { dryRun: true, edition: 'opensource' }
    );
    const gateway = yaml.load(docs[0]);
    expect(gateway.metadata.name).toBe('custom-gateway');
    expect(gateway.spec.gatewayClassName).toBe('custom-class');
  });
});

describe('GatewayFeature tls passthrough', () => {
  test('omitting tls leaves spec.tls unset (no regression for existing use cases)', async () => {
    const docs = await FeatureManager.deploy('gateway', {}, { dryRun: true });
    const gateway = yaml.load(docs[0]);
    expect(gateway.spec.tls).toBeUndefined();
  });

  test('config.tls is passed through unchanged to spec.tls', async () => {
    const tls = {
      frontend: {
        default: {
          validation: {
            mode: 'AllowValidOnly',
            caCertificateRefs: [{ name: 'ca-cert', kind: 'ConfigMap', group: '' }],
          },
        },
      },
    };
    const docs = await FeatureManager.deploy('gateway', { tls }, { dryRun: true });
    const gateway = yaml.load(docs[0]);
    expect(gateway.spec.tls).toEqual(tls);
  });
});

describe('GatewayFeature registerDns opt-in', () => {
  let originalKubectl, calls;

  beforeEach(() => {
    calls = [];
    originalKubectl = KubernetesHelper.kubectl;
    // A bare IPv4 load-balancer address short-circuits waitForGatewayReachable's own wait
    // (IPV4_RE fast path) - keeps these tests fast.
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'svc') {
        return { stdout: '10.0.0.5', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
  });

  // registerExternalDns itself (the annotate-then-wait-for-real-DNS/TLS path) is deliberately
  // not exercised here - same as waitForGatewayReachable's own hostname branch, it calls the
  // unmockable waitForPublicUrl, which polls live DNS/HTTP and would make this test slow and
  // network-dependent. Coverage stops at the opt-in gate: existing consumers that don't set
  // registerDns (even with an externally-shaped hostname) must see zero behavior change.
  test('registerDns omitted never annotates the Service, even with an external-looking hostname', async () => {
    await FeatureManager.deploy(
      'gateway',
      {
        listeners: [{ name: 'https', port: 443, protocol: 'HTTPS', hostname: 'real.example.com' }],
      },
      { dryRun: false }
    );
    const annotateCalls = calls.filter(args => args.includes('annotate'));
    expect(annotateCalls).toEqual([]);
  });

  test('registerDns: true does not annotate for a cluster-internal hostname', async () => {
    await FeatureManager.deploy(
      'gateway',
      {
        registerDns: true,
        listeners: [
          {
            name: 'https',
            port: 443,
            protocol: 'HTTPS',
            hostname: 'models-gateway.svc.cluster.local',
          },
        ],
      },
      { dryRun: false }
    );
    const annotateCalls = calls.filter(args => args.includes('annotate'));
    expect(annotateCalls).toEqual([]);
  });
});

describe('GatewayFeature registerWithTelemetry', () => {
  let originalKubectl, calls, policies;

  beforeEach(() => {
    calls = [];
    // Keyed by policy name - undefined means "not installed" (kubectl get fails).
    policies = {
      'logging-policy': { spec: { targetRefs: [] } },
      'tracing-policy': { spec: { targetRefs: [] } },
      'tracing-solo-ui': { spec: { targetRefs: [] } },
    };
    originalKubectl = KubernetesHelper.kubectl;
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'svc') {
        return { stdout: '10.0.0.5', stderr: '', exitCode: 0 }; // short-circuits waitForGatewayReachable
      }
      if (args[0] === 'get' && args[1] === 'enterpriseagentgatewaypolicy') {
        const policy = policies[args[2]];
        return policy
          ? { stdout: JSON.stringify(policy), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'not found', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  });

  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
  });

  test('appends the new Gateway to logging-policy/tracing-policy/tracing-solo-ui targetRefs', async () => {
    await FeatureManager.deploy('gateway', { name: 'governance-gateway' }, { dryRun: false });

    const patchCalls = calls.filter(args => args[0] === 'patch');
    expect(patchCalls).toHaveLength(3);
    for (const args of patchCalls) {
      const body = JSON.parse(args[args.indexOf('-p') + 1]);
      expect(body.spec.targetRefs).toContainEqual({
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: 'governance-gateway',
      });
    }
  });

  test('is a no-op when telemetry is not installed (policy lookup fails)', async () => {
    policies = {};
    await FeatureManager.deploy('gateway', { name: 'governance-gateway' }, { dryRun: false });

    expect(calls.filter(args => args[0] === 'patch')).toEqual([]);
  });

  test('does not duplicate an already-registered Gateway on a repeat deploy', async () => {
    policies['logging-policy'].spec.targetRefs = [
      { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'governance-gateway' },
    ];
    await FeatureManager.deploy('gateway', { name: 'governance-gateway' }, { dryRun: false });

    // Only tracing-policy and tracing-solo-ui (not yet registered) get patched.
    const patchCalls = calls.filter(args => args[0] === 'patch');
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls.map(args => args[2]).sort()).toEqual(['tracing-policy', 'tracing-solo-ui']);
  });

  test('skips entirely for a Gateway outside agentgateway-system (targetRefs cannot cross namespaces)', async () => {
    await FeatureManager.deploy(
      'gateway',
      { name: 'other-gateway', namespace: 'some-other-namespace' },
      { dryRun: false }
    );

    expect(calls.some(args => args[1] === 'enterpriseagentgatewaypolicy')).toBe(false);
  });
});
