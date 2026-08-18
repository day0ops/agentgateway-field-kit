import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'http';
import { UseCaseTestRunner } from '../../src/lib/usecase-tests.js';

function startEchoServer() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('UseCaseTestRunner.sendHttpRequest', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = await startEchoServer();
    port = server.address().port;
  });

  afterAll(() => {
    server.close();
  });

  test('defaults to http scheme and the provided port (legacy behavior unchanged)', async () => {
    const result = await UseCaseTestRunner.sendHttpRequest(
      '127.0.0.1',
      { endpoint: '/foo', prompt: 'hi' },
      null,
      5000,
      port
    );
    expect(result.connectionFailed).toBe(false);
    expect(result.status).toBe(200);
    expect(result.requestInfo.url).toBe(`http://127.0.0.1:${port}/foo`);
    expect(JSON.parse(result.body).method).toBe('POST');
  });

  test('step.resolve maps a hostname to the gateway IP via curl --resolve', async () => {
    const result = await UseCaseTestRunner.sendHttpRequest(
      '127.0.0.1',
      { endpoint: '/bar', prompt: 'hi', resolve: { hostname: 'usecase-test.invalid' } },
      null,
      5000,
      port
    );
    expect(result.status).toBe(200);
    expect(result.requestInfo.url).toBe(`http://usecase-test.invalid:${port}/bar`);
  });

  test('step.port overrides the usecase default port', async () => {
    const result = await UseCaseTestRunner.sendHttpRequest(
      '127.0.0.1',
      { endpoint: '/baz', prompt: 'hi', port },
      null,
      5000,
      9999
    );
    expect(result.status).toBe(200);
    expect(result.requestInfo.url).toBe(`http://127.0.0.1:${port}/baz`);
  });
});

describe('UseCaseTestRunner.resolveTlsMaterial', () => {
  test('passes through inline path strings unchanged', async () => {
    const { paths, tempFiles } = await UseCaseTestRunner.resolveTlsMaterial({
      cert: '/tmp/some-cert.pem',
      key: '/tmp/some-key.pem',
    });
    expect(paths.cert).toBe('/tmp/some-cert.pem');
    expect(paths.key).toBe('/tmp/some-key.pem');
    expect(paths.ca).toBeUndefined();
    expect(tempFiles).toEqual([]);
  });

  test('rejects a malformed entry that is neither a path nor a secretRef', async () => {
    await expect(UseCaseTestRunner.resolveTlsMaterial({ cert: 123 })).rejects.toThrow(
      /must be a file path string or \{ secretRef \}/
    );
  });

  test('rejects a secretRef missing name/namespace', async () => {
    await expect(
      UseCaseTestRunner.resolveTlsMaterial({ ca: { secretRef: { name: 'x' } } })
    ).rejects.toThrow(/requires 'name' and 'namespace'/);
  });
});

describe('UseCaseTestRunner.verifyResponse - connection-level errors', () => {
  test('expect.connectionError: true passes when the request failed at the connection level', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        { connectionFailed: true, connectionError: 'boom' },
        null,
        NaN,
        { expect: { connectionError: true } },
        null
      )
    ).resolves.toBeUndefined();
  });

  test('expect.connectionError: true fails when the request actually completed', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        { connectionFailed: false },
        'ok',
        200,
        { expect: { connectionError: true } },
        null
      )
    ).rejects.toThrow(/Expected a connection-level error/);
  });

  test('a connection failure fails any check that does not expect one', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        { connectionFailed: true, connectionError: 'TLS handshake failed' },
        null,
        NaN,
        { expect: { status: 'success' } },
        null
      )
    ).rejects.toThrow(/Request failed at the connection level: TLS handshake failed/);
  });

  test('existing http-only checks are unaffected when there is no connection failure', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        { headers: {} },
        '{"ok":true}',
        200,
        { expect: { status: 'success' } },
        null
      )
    ).resolves.toBeUndefined();
  });
});

describe('UseCaseTestRunner.verifyResponse - expect.notContains', () => {
  test('passes when the response does not contain the given text', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        {},
        '{"Authorization":"Bearer new-token"}',
        200,
        { expect: { notContains: 'old-token' } },
        null
      )
    ).resolves.toBeUndefined();
  });

  test('fails when the response contains the given text (case-insensitive)', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        {},
        '{"Authorization":"Bearer OLD-TOKEN"}',
        200,
        { expect: { notContains: 'old-token' } },
        null
      )
    ).rejects.toThrow(/Response contains unexpected text: "old-token"/);
  });

  test('checks every item in a notContains array', async () => {
    await expect(
      UseCaseTestRunner.verifyResponse(
        {},
        '{"a":"present","b":"missing"}',
        200,
        { expect: { notContains: ['absent', 'present'] } },
        null
      )
    ).rejects.toThrow(/Response contains unexpected text: "present"/);
  });
});

describe('UseCaseTestRunner.interpolateVerifyStepTokens', () => {
  test('substitutes {{bearerToken}} and {{actorToken}} in expect.contains/notContains', () => {
    const step = {
      expect: { contains: 'act as {{actorToken}}', notContains: '{{bearerToken}}' },
    };
    const result = UseCaseTestRunner.interpolateVerifyStepTokens(step, {
      bearerToken: 'bearer-xyz',
      actorToken: 'actor-abc',
    });
    expect(result.expect.contains).toBe('act as actor-abc');
    expect(result.expect.notContains).toBe('bearer-xyz');
  });

  test('substitutes within array values too', () => {
    const step = { expect: { notContains: ['{{bearerToken}}', 'literal'] } };
    const result = UseCaseTestRunner.interpolateVerifyStepTokens(step, {
      bearerToken: 'bearer-xyz',
      actorToken: null,
    });
    expect(result.expect.notContains).toEqual(['bearer-xyz', 'literal']);
  });

  test('returns the step unchanged when there is nothing to interpolate', () => {
    const step = { expect: { status: 'success' } };
    const result = UseCaseTestRunner.interpolateVerifyStepTokens(step, {
      bearerToken: 'x',
      actorToken: 'y',
    });
    expect(result).toBe(step);
  });

  test('returns the step unchanged when there is no expect block at all', () => {
    const step = { action: 'verify' };
    const result = UseCaseTestRunner.interpolateVerifyStepTokens(step, {
      bearerToken: 'x',
      actorToken: 'y',
    });
    expect(result).toBe(step);
  });
});

describe('UseCaseTestRunner.registerClient', () => {
  function startDcrServer(responder) {
    return new Promise(resolve => {
      const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const { status, json } = responder({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString(),
          });
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('POSTs to the realm registration endpoint with the expected payload', async () => {
    let captured;
    const server = await startDcrServer(req => {
      captured = req;
      return {
        status: 201,
        json: { client_id: 'generated-id', client_secret: 'generated-secret' },
      };
    });
    const port = server.address().port;

    try {
      const result = await UseCaseTestRunner.registerClient({
        keycloak: { realm: 'agw-dev', hostname: `127.0.0.1:${port}`, scheme: 'http' },
      });

      expect(captured.method).toBe('POST');
      expect(captured.url).toBe('/realms/agw-dev/clients-registrations/openid-connect');
      expect(captured.headers['content-type']).toBe('application/json');

      const payload = JSON.parse(captured.body);
      expect(payload.grant_types).toEqual(['client_credentials']);
      expect(payload.token_endpoint_auth_method).toBe('client_secret_post');
      expect(payload.redirect_uris).toEqual(['http://127.0.0.1:6276/oauth/callback']);

      expect(result).toEqual({ clientId: 'generated-id', clientSecret: 'generated-secret' });
    } finally {
      server.close();
    }
  });

  test('requests a public client (no client_secret) when keycloak.public is set', async () => {
    let captured;
    const server = await startDcrServer(req => {
      captured = req;
      return { status: 201, json: { client_id: 'generated-id' } };
    });
    const port = server.address().port;

    try {
      await UseCaseTestRunner.registerClient({
        keycloak: { realm: 'agw-dev', hostname: `127.0.0.1:${port}`, scheme: 'http', public: true },
      });
      const payload = JSON.parse(captured.body);
      expect(payload.token_endpoint_auth_method).toBe('none');
    } finally {
      server.close();
    }
  });

  test('throws when Keycloak rejects the registration', async () => {
    const server = await startDcrServer(() => ({
      status: 400,
      json: { error: 'invalid_redirect_uri', error_description: 'Invalid redirect uri' },
    }));
    const port = server.address().port;

    try {
      await expect(
        UseCaseTestRunner.registerClient({
          keycloak: { realm: 'agw-dev', hostname: `127.0.0.1:${port}`, scheme: 'http' },
        })
      ).rejects.toThrow(/Invalid redirect uri/);
    } finally {
      server.close();
    }
  });

  test('throws when the response has no client_id', async () => {
    const server = await startDcrServer(() => ({ status: 200, json: {} }));
    const port = server.address().port;

    try {
      await expect(
        UseCaseTestRunner.registerClient({
          keycloak: { realm: 'agw-dev', hostname: `127.0.0.1:${port}`, scheme: 'http' },
        })
      ).rejects.toThrow(/no client_id in response/);
    } finally {
      server.close();
    }
  });
});
