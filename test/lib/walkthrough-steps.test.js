import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import {
  runStep,
  resolveVariables,
  buildHttpRequest,
  executeHttpRequest,
  runHttpStep,
  runTrafficSplitStep,
} from '../../src/lib/walkthrough-steps.js';

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
    expect(result).toEqual({ kind: 'traffic-split', tally: { 200: 1, 429: 2 }, requestCount: 3 });
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
