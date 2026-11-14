import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import open from 'open';

const CALLBACK_PATH = '/callback';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generates a PKCE verifier/challenge pair (S256). */
function buildPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Starts a one-shot local HTTP server on an ephemeral port to catch the OAuth
 * redirect. Resolves once listening with the bound port and a promise that
 * resolves/rejects once the single expected callback request arrives.
 */
function startCallbackServer() {
  let resolveCode, rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Login complete - return to the terminal.</body></html>');
    server.close();

    if (error) rejectCode(new Error(`OIDC login failed: ${error}`));
    else resolveCode(code);
  });

  return new Promise((resolveListen, rejectListen) => {
    server.on('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      resolveListen({ port: server.address().port, codePromise });
    });
  });
}

/**
 * Resolves named OIDC credentials into bearer tokens via the loopback-redirect
 * Authorization Code + PKCE flow, caching one token per credential name for
 * the process lifetime so a credential used across multiple steps/screens
 * only triggers one browser login.
 */
export class CredentialManager {
  /** @param {object} credentials - `{ [name]: { issuerUrl, clientId } }` */
  constructor(credentials = {}, { openBrowser = open } = {}) {
    this.credentials = credentials;
    this.tokens = new Map();
    this.openBrowser = openBrowser;
  }

  /** @returns {Promise<string>} the cached or newly-acquired access token for the named credential */
  async getToken(name) {
    if (this.tokens.has(name)) return this.tokens.get(name);

    const credential = this.credentials[name];
    if (!credential) {
      throw new Error(`Unknown credential '${name}'`);
    }

    const token = await this.loginViaBrowser(credential);
    this.tokens.set(name, token);
    return token;
  }

  /**
   * Runs one full Authorization Code + PKCE loopback login. `prompt=login` forces
   * the provider to show a fresh login form even if a different credential's SSO
   * session is still active in the browser, so switching identities mid-walkthrough
   * doesn't silently reuse the wrong one.
   */
  async loginViaBrowser({ issuerUrl, clientId }) {
    const { port, codePromise } = await startCallbackServer();
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const { verifier, challenge } = buildPkcePair();

    const authUrl = new URL(`${issuerUrl}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'login');

    await this.openBrowser(authUrl.toString());
    const code = await codePromise;

    const tokenResponse = await fetch(`${issuerUrl}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error(
        `Failed to exchange OIDC code for a token: ${tokenResponse.status} ${await tokenResponse.text()}`
      );
    }
    const data = await tokenResponse.json();
    return data.access_token;
  }
}
