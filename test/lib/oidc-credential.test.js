import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { CredentialManager } from '../../src/lib/oidc-credential.js';

describe('CredentialManager.getToken', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('throws for an unknown credential name', async () => {
    const manager = new CredentialManager({});
    await expect(manager.getToken('nobody')).rejects.toThrow(/Unknown credential/);
  });

  test('performs the full loopback flow and returns the access token', async () => {
    let openedUrl = null;
    const manager = new CredentialManager(
      {
        'demo-viewer': {
          issuerUrl: 'https://keycloak.example.com/realms/agentgateway-demo',
          clientId: 'agw-demo',
        },
      },
      {
        openBrowser: async url => {
          openedUrl = url;
          const callback = new URL(url).searchParams.get('redirect_uri');
          await fetch(`${callback}?code=test-auth-code`);
        },
      }
    );

    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('http://127.0.0.1')) {
        return originalFetch(url, options);
      }
      if (String(url).includes('/protocol/openid-connect/token')) {
        const body = options.body;
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('client_id')).toBe('agw-demo');
        expect(body.get('code')).toBe('test-auth-code');
        expect(body.get('code_verifier')).toBeTruthy();
        return new Response(JSON.stringify({ access_token: 'real-token' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const token = await manager.getToken('demo-viewer');

    expect(token).toBe('real-token');
    expect(openedUrl).toContain(
      'https://keycloak.example.com/realms/agentgateway-demo/protocol/openid-connect/auth'
    );
    expect(openedUrl).toContain('client_id=agw-demo');
    expect(openedUrl).toContain('prompt=login');
    expect(openedUrl).toContain('code_challenge=');
    expect(openedUrl).toContain('code_challenge_method=S256');
  });

  test('caches the token - a second call for the same credential does not open the browser again', async () => {
    let openCount = 0;
    const manager = new CredentialManager(
      {
        'demo-viewer': {
          issuerUrl: 'https://keycloak.example.com/realms/agentgateway-demo',
          clientId: 'agw-demo',
        },
      },
      {
        openBrowser: async url => {
          openCount += 1;
          const callback = new URL(url).searchParams.get('redirect_uri');
          await fetch(`${callback}?code=test-auth-code`);
        },
      }
    );
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('http://127.0.0.1')) return originalFetch(url, options);
      return new Response(JSON.stringify({ access_token: 'real-token' }), { status: 200 });
    };

    await manager.getToken('demo-viewer');
    await manager.getToken('demo-viewer');

    expect(openCount).toBe(1);
  });

  test('rejects when the provider redirects back with an error', async () => {
    const manager = new CredentialManager(
      {
        'demo-viewer': {
          issuerUrl: 'https://keycloak.example.com/realms/agentgateway-demo',
          clientId: 'agw-demo',
        },
      },
      {
        openBrowser: async url => {
          const callback = new URL(url).searchParams.get('redirect_uri');
          await fetch(`${callback}?error=access_denied`);
        },
      }
    );
    globalThis.fetch = originalFetch;

    await expect(manager.getToken('demo-viewer')).rejects.toThrow(/access_denied/);
  });
});
