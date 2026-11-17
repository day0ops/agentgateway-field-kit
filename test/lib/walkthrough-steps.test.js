import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'node:https';
import { execaSync } from 'execa';
import {
  runStep,
  resolveVariables,
  captureResponseVariable,
  buildHttpRequest,
  executeHttpRequest,
  runHttpStep,
  runTrafficSplitStep,
  buildTrafficSplitRequest,
  executeTrafficSplitRequest,
  applyResolve,
  overrideAddress,
  buildTlsOptions,
  assertTlsOptionsSupported,
  connectionTarget,
} from '../../src/lib/walkthrough-steps.js';
import { KubernetesHelper } from '../../src/lib/common.js';
import { FeatureManager } from '../../src/lib/feature.js';

describe('resolveVariables', () => {
  test('substitutes a known variable', () => {
    const variables = new Map([['apiKey', 'secret-123']]);
    expect(resolveVariables('{{vars.apiKey}}', variables)).toBe('secret-123');
  });

  test('resolves an unset variable to an empty string', () => {
    expect(resolveVariables('{{vars.missing}}', new Map())).toBe('');
  });

  test('passes through a value with no placeholder unchanged', () => {
    expect(resolveVariables('application/json', new Map())).toBe('application/json');
  });

  test('passes through non-string values unchanged', () => {
    expect(resolveVariables(42, new Map())).toBe(42);
  });
});

describe('buildHttpRequest', () => {
  test('builds a request with no Authorization header when credential is absent', async () => {
    const request = await buildHttpRequest(
      { method: 'GET', url: 'http://example.com/v1/flights' },
      { credentials: {}, variables: new Map() }
    );
    expect(request).toEqual({ method: 'GET', url: 'http://example.com/v1/flights', headers: {} });
  });

  test('resolves a credential into a Bearer Authorization header', async () => {
    const request = await buildHttpRequest(
      { method: 'GET', url: 'http://example.com/v1/flights', credential: 'demo-viewer' },
      { credentials: { getToken: async name => `token-for-${name}` }, variables: new Map() }
    );
    expect(request.headers.Authorization).toBe('Bearer token-for-demo-viewer');
  });

  test('does not resolve a token when credential is "none"', async () => {
    const request = await buildHttpRequest(
      { method: 'GET', url: 'http://example.com', credential: 'none' },
      {
        credentials: {
          getToken: async () => {
            throw new Error('should not be called');
          },
        },
        variables: new Map(),
      }
    );
    expect(request.headers.Authorization).toBeUndefined();
  });

  test('substitutes {{vars.*}} in headers', async () => {
    const request = await buildHttpRequest(
      { method: 'GET', url: 'http://example.com', headers: { 'api-key': '{{vars.apiKey}}' } },
      { credentials: {}, variables: new Map([['apiKey', 'abc']]) }
    );
    expect(request.headers['api-key']).toBe('abc');
  });

  test('includes the body when step.body is set', async () => {
    const request = await buildHttpRequest(
      { method: 'POST', url: 'http://example.com', body: '{"prompt":"hi"}' },
      { credentials: {}, variables: new Map() }
    );
    expect(request.body).toBe('{"prompt":"hi"}');
  });

  test('omits body entirely when step.body is not set', async () => {
    const request = await buildHttpRequest(
      { method: 'GET', url: 'http://example.com' },
      { credentials: {}, variables: new Map() }
    );
    expect('body' in request).toBe(false);
  });

  test('substitutes {{vars.*}} in the body too, not just headers', async () => {
    const request = await buildHttpRequest(
      { method: 'POST', url: 'http://example.com', body: '{"model":"{{vars.tier}}"}' },
      { credentials: {}, variables: new Map([['tier', 'premium']]) }
    );
    expect(request.body).toBe('{"model":"premium"}');
  });

  test('defaults Content-Type to application/json when a body is set and none is given', async () => {
    const request = await buildHttpRequest(
      { method: 'POST', url: 'http://example.com', body: '{"prompt":"hi"}' },
      { credentials: {}, variables: new Map() }
    );
    expect(request.headers['Content-Type']).toBe('application/json');
  });

  test('does not override an explicitly-set Content-Type header', async () => {
    const request = await buildHttpRequest(
      {
        method: 'POST',
        url: 'http://example.com',
        body: 'plain text',
        headers: { 'Content-Type': 'text/plain' },
      },
      { credentials: {}, variables: new Map() }
    );
    expect(request.headers['Content-Type']).toBe('text/plain');
  });

  test('does not add Content-Type when there is no body', async () => {
    const request = await buildHttpRequest(
      { method: 'GET', url: 'http://example.com' },
      { credentials: {}, variables: new Map() }
    );
    expect(request.headers['Content-Type']).toBeUndefined();
  });
});

describe('executeHttpRequest', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('passed is true when status matches expectStatus', async () => {
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    const result = await executeHttpRequest(
      { expectStatus: 200 },
      { method: 'GET', url: 'http://example.com', headers: {} }
    );
    expect(result).toMatchObject({ status: 200, passed: true, body: 'ok' });
  });

  test('passed is false when status does not match expectStatus', async () => {
    globalThis.fetch = async () => new Response('denied', { status: 401 });
    const result = await executeHttpRequest(
      { expectStatus: 200 },
      { method: 'GET', url: 'http://example.com', headers: {} }
    );
    expect(result.passed).toBe(false);
    expect(result.status).toBe(401);
  });

  test('passed is true when expectStatus is omitted, regardless of status', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 });
    const result = await executeHttpRequest(
      {},
      { method: 'GET', url: 'http://example.com', headers: {} }
    );
    expect(result.passed).toBe(true);
  });

  test('passes when expectResponseHeader matches', async () => {
    globalThis.fetch = async () =>
      new Response('ok', { status: 200, headers: { 'X-Transformed-By': 'agentgateway' } });
    const result = await executeHttpRequest(
      {
        expectStatus: 200,
        expectResponseHeader: { name: 'X-Transformed-By', value: 'agentgateway' },
      },
      { method: 'GET', url: 'http://example.com', headers: {} }
    );
    expect(result.passed).toBe(true);
  });

  test('fails when expectResponseHeader value does not match', async () => {
    globalThis.fetch = async () => new Response('ok', { status: 200, headers: {} });
    const result = await executeHttpRequest(
      {
        expectStatus: 200,
        expectResponseHeader: { name: 'X-Transformed-By', value: 'agentgateway' },
      },
      { method: 'GET', url: 'http://example.com', headers: {} }
    );
    expect(result.passed).toBe(false);
  });

  test('a connection failure throws when expectConnectionFailure is not set', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      executeHttpRequest({}, { method: 'GET', url: 'http://example.com', headers: {} })
    ).rejects.toThrow('ECONNREFUSED');
  });

  test('a connection failure passes when expectConnectionFailure is set', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await executeHttpRequest(
      { expectConnectionFailure: true },
      { method: 'GET', url: 'http://example.com', headers: {} }
    );
    expect(result).toMatchObject({ status: null, passed: true });
  });
});

describe('captureResponseVariable', () => {
  test('does nothing when the step has no captureVariable', () => {
    const variables = new Map();
    captureResponseVariable({}, { body: '{"tier":"premium"}' }, variables);
    expect(variables.size).toBe(0);
  });

  test('stores the first jsonPath that resolves', () => {
    const variables = new Map();
    const step = {
      captureVariable: { name: 'tier', jsonPaths: ['answers.tier', 'tier'], default: 'cheap' },
    };
    captureResponseVariable(step, { body: '{"tier":"premium"}' }, variables);
    expect(variables.get('tier')).toBe('premium');
  });

  test('indexes an array with a numeric path segment', () => {
    const variables = new Map();
    const step = { captureVariable: { name: 'tier', jsonPaths: ['answers.0.option'] } };
    captureResponseVariable(
      step,
      { body: '{"answers":[{"option":"premium","confidence":0.9}]}' },
      variables
    );
    expect(variables.get('tier')).toBe('premium');
  });

  test('falls back to default when no jsonPath resolves', () => {
    const variables = new Map();
    const step = { captureVariable: { name: 'tier', jsonPaths: ['nope'], default: 'cheap' } };
    captureResponseVariable(step, { body: '{"other":"value"}' }, variables);
    expect(variables.get('tier')).toBe('cheap');
  });

  test('falls back to default (not an exception) when the body is not JSON', () => {
    const variables = new Map();
    const step = { captureVariable: { name: 'tier', jsonPaths: ['tier'], default: 'cheap' } };
    captureResponseVariable(step, { body: 'not json' }, variables);
    expect(variables.get('tier')).toBe('cheap');
  });

  test('falls back to an empty string when no default is given and nothing resolves', () => {
    const variables = new Map();
    const step = { captureVariable: { name: 'tier', jsonPaths: ['nope'] } };
    captureResponseVariable(step, { body: '{"other":"value"}' }, variables);
    expect(variables.get('tier')).toBe('');
  });
});

describe('runHttpStep', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('builds and fires in one call', async () => {
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    const result = await runHttpStep(
      { method: 'GET', url: 'http://example.com', expectStatus: 200 },
      { credentials: {}, variables: new Map() }
    );
    expect(result).toMatchObject({ kind: 'http', status: 200, passed: true });
  });

  test('sends the body through to fetch when step.body is set', async () => {
    let seenOptions;
    globalThis.fetch = async (_url, options) => {
      seenOptions = options;
      return new Response('ok', { status: 200 });
    };
    await runHttpStep(
      { method: 'POST', url: 'http://example.com', body: '{"prompt":"hi"}' },
      { credentials: {}, variables: new Map() }
    );
    expect(seenOptions.body).toBe('{"prompt":"hi"}');
    expect(seenOptions.headers['Content-Type']).toBe('application/json');
  });

  test('sends no body to fetch when step.body is not set', async () => {
    let seenOptions;
    globalThis.fetch = async (_url, options) => {
      seenOptions = options;
      return new Response('ok', { status: 200 });
    };
    await runHttpStep(
      { method: 'GET', url: 'http://example.com' },
      { credentials: {}, variables: new Map() }
    );
    expect('body' in seenOptions).toBe(false);
  });
});

describe('runTrafficSplitStep', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('tallies responses by the configured JSON field', async () => {
    const colors = ['blue', 'blue', 'green', 'blue'];
    let i = 0;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ color: colors[i++] }), { status: 200 });

    const result = await runTrafficSplitStep(
      { url: 'http://example.com/v1/meta', requestCount: 4, tallyBy: 'color' },
      { credentials: {}, variables: new Map() }
    );
    expect(result).toEqual({
      kind: 'traffic-split',
      request: { method: 'GET', url: 'http://example.com/v1/meta', headers: {} },
      tally: { blue: 3, green: 1 },
      requestCount: 4,
    });
  });

  test('tallies by HTTP status when tallyBy is "$status", without parsing a non-JSON body', async () => {
    const statuses = [200, 429, 429];
    let i = 0;
    globalThis.fetch = async () => new Response('plain text, not JSON', { status: statuses[i++] });

    const result = await runTrafficSplitStep(
      { url: 'http://example.com/v1/airports', requestCount: 3, tallyBy: '$status' },
      { credentials: {}, variables: new Map() }
    );
    expect(result).toEqual({
      kind: 'traffic-split',
      request: { method: 'GET', url: 'http://example.com/v1/airports', headers: {} },
      tally: { 200: 1, 429: 2 },
      requestCount: 3,
    });
  });

  test('resolves a credential and {{vars.*}} headers on every request', async () => {
    let seenHeaders;
    globalThis.fetch = async (_url, options) => {
      seenHeaders = options.headers;
      return new Response(JSON.stringify({ color: 'blue' }), { status: 200 });
    };
    await runTrafficSplitStep(
      {
        url: 'http://example.com',
        requestCount: 1,
        tallyBy: 'color',
        headers: { 'api-key': '{{vars.apiKey}}' },
      },
      { credentials: {}, variables: new Map([['apiKey', 'abc']]) }
    );
    expect(seenHeaders['api-key']).toBe('abc');
  });

  test('sends method and body when step.method/step.body are set', async () => {
    let seenOptions;
    globalThis.fetch = async (_url, options) => {
      seenOptions = options;
      return new Response(JSON.stringify({ color: 'blue' }), { status: 200 });
    };
    await runTrafficSplitStep(
      {
        url: 'http://example.com',
        requestCount: 1,
        tallyBy: 'color',
        method: 'POST',
        body: '{"prompt":"hi"}',
      },
      { credentials: {}, variables: new Map() }
    );
    expect(seenOptions.method).toBe('POST');
    expect(seenOptions.body).toBe('{"prompt":"hi"}');
  });

  test('defaults to a bodyless GET when step.method/step.body are not set', async () => {
    let seenOptions;
    globalThis.fetch = async (_url, options) => {
      seenOptions = options;
      return new Response(JSON.stringify({ color: 'blue' }), { status: 200 });
    };
    await runTrafficSplitStep(
      { url: 'http://example.com', requestCount: 1, tallyBy: 'color' },
      { credentials: {}, variables: new Map() }
    );
    expect(seenOptions.method).toBe('GET');
    expect('body' in seenOptions).toBe(false);
  });

  describe('gatewayMetric', () => {
    let originalKubectl, originalGetLoadBalancerAddress;
    beforeEach(() => {
      originalKubectl = KubernetesHelper.kubectl;
      originalGetLoadBalancerAddress = KubernetesHelper.getLoadBalancerAddress;
      // Stubbed separately from the kubectl mock below - getLoadBalancerAddress is a
      // polling loop that calls kubectl internally, which would otherwise collide with
      // (and poll-loop against) the gatewayMetric calls these tests are asserting on.
      KubernetesHelper.getLoadBalancerAddress = async () => '127.0.0.1';
      globalThis.fetch = async () => new Response('plain text', { status: 200 });
    });
    afterEach(() => {
      KubernetesHelper.kubectl = originalKubectl;
      KubernetesHelper.getLoadBalancerAddress = originalGetLoadBalancerAddress;
    });

    test('snapshots the named counter before and after the burst and returns the delta', async () => {
      const kubectlCalls = [];
      let metricValue = 10;
      KubernetesHelper.kubectl = async args => {
        kubectlCalls.push(args);
        if (args[0] === 'get') return { stdout: 'gw-pod-abc123' };
        // The 2nd exec (after the burst) sees 3 more retries than the 1st.
        const value = metricValue;
        metricValue = 13;
        return {
          stdout: `# HELP agentgateway_retries_total docs\nagentgateway_retries_total ${value}\n`,
        };
      };

      const step = {
        url: 'http://example.com',
        requestCount: 3,
        tallyBy: '$status',
        resolveGateway: { name: 'models-gateway', namespace: 'agentgateway-system' },
        gatewayMetric: 'agentgateway_retries_total',
      };
      const request = await buildTrafficSplitRequest(step, {
        credentials: {},
        variables: new Map(),
      });
      const result = await executeTrafficSplitRequest(step, request);

      expect(result.gatewayMetricDelta).toEqual({ name: 'agentgateway_retries_total', delta: 3 });
      // get pod, exec curl (before) - get pod, exec curl (after)
      expect(kubectlCalls).toHaveLength(4);
      expect(kubectlCalls[0]).toEqual([
        'get',
        'pods',
        '-n',
        'agentgateway-system',
        '-l',
        'app.kubernetes.io/name=models-gateway',
        '-o',
        'jsonpath={.items[0].metadata.name}',
      ]);
      expect(kubectlCalls[1]).toEqual([
        'exec',
        'gw-pod-abc123',
        '-n',
        'agentgateway-system',
        '--',
        'curl',
        '-s',
        'localhost:15020/metrics',
      ]);
    });

    test('omits gatewayMetricDelta (rather than failing the step) when the pod cannot be found', async () => {
      KubernetesHelper.kubectl = async () => ({ stdout: '' });
      const step = {
        url: 'http://example.com',
        requestCount: 1,
        tallyBy: '$status',
        resolveGateway: { name: 'models-gateway' },
        gatewayMetric: 'agentgateway_retries_total',
      };
      const request = await buildTrafficSplitRequest(step, {
        credentials: {},
        variables: new Map(),
      });
      const result = await executeTrafficSplitRequest(step, request);
      expect(result.gatewayMetricDelta).toBeUndefined();
    });

    test('omits gatewayMetricDelta when step.resolveGateway is not set', async () => {
      const step = {
        url: 'http://example.com',
        requestCount: 1,
        tallyBy: '$status',
        gatewayMetric: 'agentgateway_retries_total',
      };
      const request = await buildTrafficSplitRequest(step, {
        credentials: {},
        variables: new Map(),
      });
      const result = await executeTrafficSplitRequest(step, request);
      expect(result.gatewayMetricDelta).toBeUndefined();
    });
  });
});

describe('applyResolve', () => {
  test('rewrites hostname to the override address, keeps original Host header and SNI', () => {
    const result = applyResolve('https://models-gateway.test/path', '10.0.0.5');
    expect(result.url).toBe('https://10.0.0.5/path');
    expect(result.hostHeader).toBe('models-gateway.test');
    expect(result.serverName).toBe('models-gateway.test');
  });

  test('wraps an IPv6 override address in brackets', () => {
    const result = applyResolve('https://models-gateway.test/path', '::1');
    expect(result.url).toBe('https://[::1]/path');
  });

  test('throws when the override address is not a real IP or DNS name', () => {
    expect(() => applyResolve('https://models-gateway.test/path', '<LB-IP>')).toThrow(
      /not an IP address or hostname/
    );
  });

  test('accepts a DNS name override address', () => {
    const result = applyResolve('https://models-gateway.test/path', 'lb.internal.example.com');
    expect(result.url).toBe('https://lb.internal.example.com/path');
  });

  test('keeps the original host (with port) as hostHeader when the URL has an explicit port', () => {
    const result = applyResolve('https://models-gateway.test:8443/path', '10.0.0.5');
    expect(result.hostHeader).toBe('models-gateway.test:8443');
    expect(result.serverName).toBe('models-gateway.test');
  });
});

describe('overrideAddress', () => {
  let originalGetLoadBalancerAddress;
  beforeEach(() => {
    originalGetLoadBalancerAddress = KubernetesHelper.getLoadBalancerAddress;
  });
  afterEach(() => {
    KubernetesHelper.getLoadBalancerAddress = originalGetLoadBalancerAddress;
  });

  test('resolveGateway calls getLoadBalancerAddress with the right namespace/name/timeout and returns its result', async () => {
    const calls = [];
    KubernetesHelper.getLoadBalancerAddress = async (namespace, name, timeout) => {
      calls.push({ namespace, name, timeout });
      return '10.0.0.9';
    };
    const address = await overrideAddress(
      {
        label: 'Call the gateway',
        resolveGateway: { name: 'models-gateway', namespace: 'custom-ns' },
      },
      'https://models-gateway.test/v1/chat'
    );
    expect(address).toBe('10.0.0.9');
    expect(calls).toEqual([{ namespace: 'custom-ns', name: 'models-gateway', timeout: 30 }]);
  });

  test('resolveGateway defaults namespace via FeatureManager.getDefaultNamespace()', async () => {
    const calls = [];
    KubernetesHelper.getLoadBalancerAddress = async (namespace, name) => {
      calls.push({ namespace, name });
      return '10.0.0.9';
    };
    await overrideAddress(
      { label: 'Call the gateway', resolveGateway: { name: 'models-gateway' } },
      'https://models-gateway.test/v1/chat'
    );
    expect(calls[0].namespace).toBe(FeatureManager.getDefaultNamespace());
  });

  test('rethrows a resolveGateway timeout with the step label and namespace/name, not the bare message', async () => {
    KubernetesHelper.getLoadBalancerAddress = async () => {
      throw new Error('Timeout waiting for LoadBalancer address');
    };
    await expect(
      overrideAddress(
        {
          label: 'Call the gateway',
          resolveGateway: { name: 'models-gateway', namespace: 'custom-ns' },
        },
        'https://models-gateway.test/v1/chat'
      )
    ).rejects.toThrow(
      "Step 'Call the gateway' resolveGateway 'custom-ns/models-gateway': no LoadBalancer address within 30s"
    );
  });

  test('rethrown resolveGateway timeout keeps the original error as .cause', async () => {
    const originalError = new Error('Timeout waiting for LoadBalancer address');
    KubernetesHelper.getLoadBalancerAddress = async () => {
      throw originalError;
    };
    try {
      await overrideAddress(
        {
          label: 'Call the gateway',
          resolveGateway: { name: 'models-gateway', namespace: 'custom-ns' },
        },
        'https://models-gateway.test/v1/chat'
      );
      throw new Error('expected overrideAddress to throw');
    } catch (error) {
      expect(error.cause).toBe(originalError);
    }
  });

  test('resolveGateway timeout still throws even when the step also sets expectConnectionFailure', async () => {
    KubernetesHelper.getLoadBalancerAddress = async () => {
      throw new Error('Timeout waiting for LoadBalancer address');
    };
    await expect(
      overrideAddress(
        {
          label: 'Call the gateway',
          resolveGateway: { name: 'models-gateway', namespace: 'custom-ns' },
          expectConnectionFailure: true,
        },
        'https://models-gateway.test/v1/chat'
      )
    ).rejects.toThrow(/no LoadBalancer address/);
  });

  test('resolve returns just the address part when host matches the URL', async () => {
    const address = await overrideAddress(
      { label: 'Call the gateway', resolve: 'models-gateway.test:443:10.0.0.9' },
      'https://models-gateway.test/v1/chat'
    );
    expect(address).toBe('10.0.0.9');
  });

  test('resolve throws when its host does not match the URL hostname', async () => {
    await expect(
      overrideAddress(
        { label: 'Call the gateway', resolve: 'wrong-host.test:443:10.0.0.9' },
        'https://models-gateway.test/v1/chat'
      )
    ).rejects.toThrow(
      "Step 'Call the gateway' resolve host 'wrong-host.test' does not match its URL's host"
    );
  });

  test('resolve throws when its port does not match the URL port', async () => {
    await expect(
      overrideAddress(
        { label: 'Call the gateway', resolve: 'models-gateway.test:8443:10.0.0.9' },
        'https://models-gateway.test/v1/chat'
      )
    ).rejects.toThrow("Step 'Call the gateway' resolve port '8443' does not match its URL's port");
  });

  test('resolve throws when the value is not in host:port:address form', async () => {
    await expect(
      overrideAddress(
        { label: 'Call the gateway', resolve: 'not-valid' },
        'https://models-gateway.test/v1/chat'
      )
    ).rejects.toThrow(
      "Step 'Call the gateway' resolve 'not-valid' is not in host:port:address form"
    );
  });

  test('both resolve and resolveGateway set throws', async () => {
    await expect(
      overrideAddress(
        {
          label: 'Call the gateway',
          resolve: 'models-gateway.test:443:10.0.0.9',
          resolveGateway: { name: 'models-gateway' },
        },
        'https://models-gateway.test/v1/chat'
      )
    ).rejects.toThrow("Step 'Call the gateway' sets both resolve and resolveGateway");
  });

  test('neither set returns null', async () => {
    const address = await overrideAddress(
      { label: 'Call the gateway' },
      'https://models-gateway.test/v1/chat'
    );
    expect(address).toBeNull();
  });
});

describe('buildTlsOptions', () => {
  let originalKubectl;
  let tmpDir;
  beforeEach(() => {
    originalKubectl = KubernetesHelper.kubectl;
    tmpDir = mkdtempSync(join(tmpdir(), 'agw-walkthrough-steps-test-'));
  });
  afterEach(() => {
    KubernetesHelper.kubectl = originalKubectl;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('insecure sets rejectUnauthorized: false', async () => {
    const tls = await buildTlsOptions({ label: 'Call it', insecure: true });
    expect(tls).toMatchObject({ rejectUnauthorized: false });
  });

  test('clientCertRef without clientKeyRef throws', async () => {
    await expect(
      buildTlsOptions({ label: 'Call it', clientCertRef: '/tmp/cert.pem' })
    ).rejects.toThrow(/clientCertRef/);
  });

  test('clientKeyRef without clientCertRef throws', async () => {
    await expect(
      buildTlsOptions({ label: 'Call it', clientKeyRef: '/tmp/key.pem' })
    ).rejects.toThrow(/clientKeyRef/);
  });

  test('both clientCertRef and clientCertSecret set throws', async () => {
    await expect(
      buildTlsOptions({
        label: 'Call it',
        clientCertRef: '/tmp/cert.pem',
        clientKeyRef: '/tmp/key.pem',
        clientCertSecret: { name: 'my-tls' },
      })
    ).rejects.toThrow(/clientCertSecret/);
  });

  test('neither TLS field set resolves to undefined', async () => {
    const tls = await buildTlsOptions({ label: 'Call it' });
    expect(tls).toBeUndefined();
  });

  test('reads clientCertRef/clientKeyRef from local PEM files', async () => {
    const certPath = join(tmpDir, 'cert.pem');
    const keyPath = join(tmpDir, 'key.pem');
    writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n');
    const tls = await buildTlsOptions({
      label: 'Call it',
      clientCertRef: certPath,
      clientKeyRef: keyPath,
    });
    expect(tls.cert).toContain('BEGIN CERTIFICATE');
    expect(tls.key).toContain('BEGIN PRIVATE KEY');
  });

  test('clientCertSecret reads a live kubernetes.io/tls Secret and base64-decodes tls.crt/tls.key', async () => {
    const calls = [];
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: 'kubernetes.io/tls',
          data: {
            'tls.crt': Buffer.from('cert-contents').toString('base64'),
            'tls.key': Buffer.from('key-contents').toString('base64'),
          },
        }),
      };
    };
    const tls = await buildTlsOptions({
      label: 'Call it',
      clientCertSecret: { name: 'my-tls', namespace: 'custom-ns' },
    });
    expect(tls.cert).toBe('cert-contents');
    expect(tls.key).toBe('key-contents');
    expect(calls).toEqual([['get', 'secret', 'my-tls', '-n', 'custom-ns', '-o', 'json']]);
  });

  test('clientCertSecret defaults namespace via FeatureManager.getDefaultNamespace()', async () => {
    const calls = [];
    KubernetesHelper.kubectl = async args => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            'tls.crt': Buffer.from('cert-contents').toString('base64'),
            'tls.key': Buffer.from('key-contents').toString('base64'),
          },
        }),
      };
    };
    await buildTlsOptions({ label: 'Call it', clientCertSecret: { name: 'my-tls' } });
    expect(calls[0]).toContain(FeatureManager.getDefaultNamespace());
  });

  test('a malformed Secret (missing tls.crt/tls.key) throws', async () => {
    KubernetesHelper.kubectl = async () => ({ exitCode: 0, stdout: JSON.stringify({ data: {} }) });
    await expect(
      buildTlsOptions({ label: 'Call it', clientCertSecret: { name: 'my-tls', namespace: 'ns' } })
    ).rejects.toThrow(/my-tls/);
  });

  test('a malformed Secret still throws even when expectConnectionFailure is set', async () => {
    KubernetesHelper.kubectl = async () => ({ exitCode: 0, stdout: JSON.stringify({ data: {} }) });
    await expect(
      buildTlsOptions({
        label: 'Call it',
        clientCertSecret: { name: 'my-tls', namespace: 'ns' },
        expectConnectionFailure: true,
      })
    ).rejects.toThrow(/my-tls/);
  });

  test('a kubectl read failure (secret not found) throws, even when expectConnectionFailure is set', async () => {
    KubernetesHelper.kubectl = async () => {
      throw new Error('secrets "my-tls" not found');
    };
    await expect(
      buildTlsOptions({
        label: 'Call it',
        clientCertSecret: { name: 'my-tls', namespace: 'ns' },
        expectConnectionFailure: true,
      })
    ).rejects.toThrow(/not found/);
  });
});

describe('assertTlsOptionsSupported', () => {
  test('passes when versions.bun is set and the step has a TLS option', () => {
    expect(() =>
      assertTlsOptionsSupported({ label: 'Call it', insecure: true }, { bun: '1.3.14' })
    ).not.toThrow();
  });

  test('throws the exact message when versions.bun is not set and insecure is set', () => {
    expect(() => assertTlsOptionsSupported({ label: 'Call it', insecure: true }, {})).toThrow(
      "Step 'Call it' needs TLS options only Bun's fetch supports - run agw with Bun (bun src/cli.js)"
    );
  });

  test('throws when versions.bun is not set and ONLY resolveGateway is set (no other TLS option)', () => {
    expect(() =>
      assertTlsOptionsSupported(
        { label: 'Call it', resolveGateway: { name: 'models-gateway' } },
        {}
      )
    ).toThrow(
      "Step 'Call it' needs TLS options only Bun's fetch supports - run agw with Bun (bun src/cli.js)"
    );
  });

  test('throws when versions.bun is not set and ONLY resolve is set (no other TLS option)', () => {
    expect(() =>
      assertTlsOptionsSupported(
        { label: 'Call it', resolve: 'models-gateway.test:443:10.0.0.9' },
        {}
      )
    ).toThrow(/needs TLS options only Bun's fetch supports/);
  });

  test('does not throw when neither a TLS option nor an address override is set, regardless of versions.bun', () => {
    expect(() => assertTlsOptionsSupported({ label: 'Call it' }, {})).not.toThrow();
  });
});

describe('against a real TLS server (resolve/insecure/client-cert/body)', () => {
  let tmpDir, serverKeyPath, serverCertPath, clientKeyPath, clientCertPath, server, port, received;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agw-walkthrough-steps-tls-'));
    serverKeyPath = join(tmpDir, 'server-key.pem');
    serverCertPath = join(tmpDir, 'server-cert.pem');
    clientKeyPath = join(tmpDir, 'client-key.pem');
    clientCertPath = join(tmpDir, 'client-cert.pem');

    // Self-signed certs (own issuer == own subject) - the server trusts the client cert
    // directly as its CA, so no separate CA keypair is needed for this test.
    execaSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      serverKeyPath,
      '-out',
      serverCertPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=models-gateway.invalid.test',
    ]);
    execaSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      clientKeyPath,
      '-out',
      clientCertPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=test-client',
    ]);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    received = [];
    server = createServer(
      {
        key: readFileSync(serverKeyPath),
        cert: readFileSync(serverCertPath),
        ca: readFileSync(clientCertPath),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          received.push({ host: req.headers.host, body, contentType: req.headers['content-type'] });
          res.end('ok');
        });
      }
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('http step: sends client cert, honors insecure, rewrites via resolve, keeps Host/content-type/body', async () => {
    const step = {
      label: 'Call the gateway',
      kind: 'http',
      method: 'POST',
      url: `https://models-gateway.invalid.test:${port}/post`,
      resolve: `models-gateway.invalid.test:${port}:127.0.0.1`,
      insecure: true,
      clientCertRef: clientCertPath,
      clientKeyRef: clientKeyPath,
      body: '{"hello":"world"}',
    };

    const result = await runHttpStep(step, { credentials: {}, variables: new Map() });

    expect(result.status).toBe(200);
    expect(received).toEqual([
      {
        host: `models-gateway.invalid.test:${port}`,
        body: '{"hello":"world"}',
        contentType: 'application/json',
      },
    ]);
  });

  test('traffic-split step: resolveGateway resolved once, every request POSTs its body to the server', async () => {
    const originalGetLoadBalancerAddress = KubernetesHelper.getLoadBalancerAddress;
    const lbCalls = [];
    KubernetesHelper.getLoadBalancerAddress = async (...args) => {
      lbCalls.push(args);
      return '127.0.0.1';
    };
    try {
      const step = {
        label: 'Burst traffic',
        kind: 'traffic-split',
        method: 'POST',
        url: `https://models-gateway.invalid.test:${port}/post`,
        resolveGateway: { name: 'models-gateway', namespace: 'custom-ns' },
        insecure: true,
        clientCertRef: clientCertPath,
        clientKeyRef: clientKeyPath,
        body: '{"hello":"world"}',
        requestCount: 3,
        tallyBy: '$status',
      };

      const result = await runStep(step, { credentials: {}, variables: new Map() });

      expect(result.tally).toEqual({ 200: 3 });
      expect(received).toHaveLength(3);
      for (const req of received) {
        expect(req.body).toBe('{"hello":"world"}');
        expect(req.host).toBe(`models-gateway.invalid.test:${port}`);
      }
      expect(lbCalls).toEqual([['custom-ns', 'models-gateway', 30]]);
    } finally {
      KubernetesHelper.getLoadBalancerAddress = originalGetLoadBalancerAddress;
    }
  });
});

describe('runStep', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('dispatches to runHttpStep for kind "http"', async () => {
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    const result = await runStep(
      { kind: 'http', method: 'GET', url: 'http://example.com' },
      { credentials: {}, variables: new Map() }
    );
    expect(result.kind).toBe('http');
  });

  test('dispatches to runTrafficSplitStep for kind "traffic-split"', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ color: 'blue' }), { status: 200 });
    const result = await runStep(
      { kind: 'traffic-split', url: 'http://example.com', requestCount: 1, tallyBy: 'color' },
      { credentials: {}, variables: new Map() }
    );
    expect(result.kind).toBe('traffic-split');
  });

  test('throws for an unknown kind', async () => {
    await expect(
      runStep({ kind: 'unknown' }, { credentials: {}, variables: new Map() })
    ).rejects.toThrow(/Unknown step kind/);
  });

  test('throws for kind "prompt" - prompt is engine-level only, never dispatched here', async () => {
    await expect(
      runStep({ kind: 'prompt' }, { credentials: {}, variables: new Map() })
    ).rejects.toThrow(/Unknown step kind/);
  });
});
