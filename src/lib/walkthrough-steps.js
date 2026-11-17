import { isIP } from 'node:net';
import { readFile } from 'fs/promises';
import { KubernetesHelper } from './common.js';
import { FeatureManager } from './feature.js';

const DNS_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/i;

/**
 * Rewrites a URL's hostname to a resolved connection address (an LB IP or alternate DNS
 * name), while keeping the original hostname available for the Host header and TLS SNI -
 * the curl `--resolve` / resolveGateway pattern. Throws if `address` is neither a valid IP
 * nor a valid DNS name.
 */
export function applyResolve(url, address) {
  const target = new URL(url);
  const ipVersion = isIP(address);
  if (ipVersion === 0 && !DNS_NAME_RE.test(address)) {
    throw new Error(
      `Cannot connect to '${address}' in place of ${target.hostname}: not an IP address or hostname`
    );
  }
  const serverName = target.hostname;
  const hostHeader = target.host;
  target.hostname = ipVersion === 6 ? `[${address}]` : address;
  return { url: target.toString(), hostHeader, serverName };
}

const RESOLVE_RE = /^([^:]+):(\d+):(.+)$/;
const RESOLVE_GATEWAY_TIMEOUT_SECONDS = 30;

/**
 * Resolves a step's `resolveGateway`/`resolve` field, if any, into a connection address
 * to use in place of `url`'s real hostname - or `null` when neither field is set. Throws
 * if both fields are set, if `resolve` isn't in `host:port:address` form, or if its host
 * doesn't match `url`'s hostname.
 */
export async function overrideAddress(step, url) {
  if (step.resolveGateway && step.resolve) {
    throw new Error(`Step '${step.label}' sets both resolve and resolveGateway`);
  }

  if (step.resolveGateway) {
    const { name, namespace = FeatureManager.getDefaultNamespace() } = step.resolveGateway;
    try {
      return await KubernetesHelper.getLoadBalancerAddress(
        namespace,
        name,
        RESOLVE_GATEWAY_TIMEOUT_SECONDS
      );
    } catch (cause) {
      throw new Error(
        `Step '${step.label}' resolveGateway '${namespace}/${name}': no LoadBalancer address within ${RESOLVE_GATEWAY_TIMEOUT_SECONDS}s`,
        { cause }
      );
    }
  }

  if (step.resolve) {
    const match = RESOLVE_RE.exec(step.resolve);
    if (!match) {
      throw new Error(
        `Step '${step.label}' resolve '${step.resolve}' is not in host:port:address form`
      );
    }
    const [, host, port, address] = match;
    const target = new URL(url);
    if (host !== target.hostname) {
      throw new Error(`Step '${step.label}' resolve host '${host}' does not match its URL's host`);
    }
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
    if (port !== targetPort) {
      throw new Error(`Step '${step.label}' resolve port '${port}' does not match its URL's port`);
    }
    return address;
  }

  return null;
}

/**
 * Builds a step's TLS options for Bun's fetch - `insecure` and/or a client certificate
 * (from local PEM files via `clientCertRef`/`clientKeyRef`, or a live `kubernetes.io/tls`
 * Secret via `clientCertSecret`). Resolves to `undefined` when the step sets none of these.
 */
export async function buildTlsOptions(step) {
  const hasLocalCert = step.clientCertRef || step.clientKeyRef;
  if (hasLocalCert && step.clientCertSecret) {
    throw new Error(
      `Step '${step.label}' sets both clientCertSecret and clientCertRef/clientKeyRef`
    );
  }
  if (Boolean(step.clientCertRef) !== Boolean(step.clientKeyRef)) {
    throw new Error(`Step '${step.label}' sets clientCertRef without clientKeyRef, or vice versa`);
  }

  let cert;
  let key;
  if (step.clientCertRef && step.clientKeyRef) {
    cert = await readFile(step.clientCertRef, 'utf8');
    key = await readFile(step.clientKeyRef, 'utf8');
  } else if (step.clientCertSecret) {
    const { name, namespace = FeatureManager.getDefaultNamespace() } = step.clientCertSecret;
    const result = await KubernetesHelper.kubectl([
      'get',
      'secret',
      name,
      '-n',
      namespace,
      '-o',
      'json',
    ]);
    const secret = JSON.parse(result.stdout);
    const certB64 = secret.data?.['tls.crt'];
    const keyB64 = secret.data?.['tls.key'];
    if (!certB64 || !keyB64) {
      throw new Error(
        `Step '${step.label}' clientCertSecret '${namespace}/${name}' is missing tls.crt/tls.key`
      );
    }
    cert = Buffer.from(certB64, 'base64').toString('utf8');
    key = Buffer.from(keyB64, 'base64').toString('utf8');
  }

  if (!step.insecure && cert === undefined) {
    return undefined;
  }
  return {
    ...(step.insecure && { rejectUnauthorized: false }),
    ...(cert !== undefined && { cert, key }),
  };
}

/**
 * Throws when a step requests TLS options or a connection-address override but isn't
 * running under Bun - only Bun's fetch supports per-request TLS settings. A no-op when
 * the step sets none of those fields, regardless of `versions`.
 */
export function assertTlsOptionsSupported(step, versions = process.versions) {
  const needsBun = Boolean(
    step.insecure ||
    step.clientCertRef ||
    step.clientKeyRef ||
    step.clientCertSecret ||
    step.resolveGateway ||
    step.resolve
  );
  if (needsBun && !versions.bun) {
    throw new Error(
      `Step '${step.label}' needs TLS options only Bun's fetch supports - run agw with Bun (bun src/cli.js)`
    );
  }
}

/**
 * Resolves a step's connection target: its TLS options (`buildTlsOptions`), an address
 * override (`overrideAddress`), and - if an address was found - the rewritten url/headers/tls
 * from `applyResolve`, dropping any existing `host`/`Host` header first. Returns `url`/`headers`
 * unchanged, alongside `tls`, when the step sets no address override.
 */
export async function connectionTarget(step, url, headers) {
  assertTlsOptionsSupported(step);
  const tls = await buildTlsOptions(step);
  const address = await overrideAddress(step, url);
  if (!address) {
    return { url, headers, tls };
  }

  const { url: resolvedUrl, hostHeader, serverName } = applyResolve(url, address);
  const headersWithoutHost = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'host')
  );
  return {
    url: resolvedUrl,
    headers: { ...headersWithoutHost, Host: hostHeader },
    tls: { ...tls, serverName },
  };
}

/**
 * Executes one walkthrough step and returns a plain result object describing what
 * happened, for the TUI to render. An unexpected HTTP status is still a normal
 * result (passed: false) - only a transport-level failure (network error, unknown
 * step kind) throws.
 */
export async function runStep(step, context) {
  switch (step.kind) {
    case 'http':
      return runHttpStep(step, context);
    case 'traffic-split':
      return runTrafficSplitStep(step, context);
    default:
      throw new Error(`Unknown step kind: '${step.kind}'`);
  }
}

/**
 * Substitutes {{vars.NAME}} placeholders from the walkthrough engine's variables map (e.g. a
 * prompt step's submitted API key) - an unset name resolves to '', and a value with no
 * placeholder at all passes through unchanged.
 */
export function resolveVariables(value, variables) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{vars\.(\w+)\}\}/g, (_match, name) => variables?.get(name) ?? '');
}

function hasContentTypeHeader(headers) {
  return Object.keys(headers).some(key => key.toLowerCase() === 'content-type');
}

/** Builds a step's headers - `{{vars.*}}`-resolved, a Bearer token if `step.credential` is set,
 * and a default `Content-Type: application/json` when the step has a body and no explicit
 * content-type header (fetch otherwise defaults a plain string body to text/plain). */
async function buildHeaders(step, context) {
  const headers = {};
  for (const [key, value] of Object.entries(step.headers || {})) {
    headers[key] = resolveVariables(value, context?.variables);
  }
  if (step.body !== undefined && !hasContentTypeHeader(headers)) {
    headers['Content-Type'] = 'application/json';
  }
  if (step.credential && step.credential !== 'none') {
    const token = await context.credentials.getToken(step.credential);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Builds an http step's request (method, url, headers, body), resolving `step.credential` into a
 * Bearer token if set - but does not fire it. Split out from executeHttpRequest so the TUI can
 * show the request (the curl line) before the request is actually sent, rather than only after
 * it's already resolved.
 */
export async function buildHttpRequest(step, context) {
  const method = step.method || 'GET';
  const headers = await buildHeaders(step, context);
  return { method, url: step.url, headers, ...(step.body !== undefined && { body: step.body }) };
}

/**
 * Fires an already-built http request and returns the full result.
 * `step.expectConnectionFailure` declares the request should fail to even connect (e.g. a
 * Gateway listener was removed) - without it, a connection failure still throws (a real
 * transport error, not a walkthrough outcome to render).
 */
export async function executeHttpRequest(step, request) {
  const target = await connectionTarget(step, request.url, request.headers);
  let response;
  try {
    response = await fetch(target.url, {
      method: request.method,
      headers: target.headers,
      ...(request.body !== undefined && { body: request.body }),
      ...(target.tls && { tls: target.tls }),
    });
  } catch (error) {
    if (!step.expectConnectionFailure) throw error;
    return {
      kind: 'http',
      request,
      status: null,
      expectStatus: step.expectStatus,
      expectResponseHeader: step.expectResponseHeader,
      passed: true,
      body: error.message,
    };
  }

  const body = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  const statusMatches = step.expectStatus === undefined || response.status === step.expectStatus;
  const headerMatches =
    !step.expectResponseHeader ||
    headers[step.expectResponseHeader.name.toLowerCase()] === step.expectResponseHeader.value;
  return {
    kind: 'http',
    request,
    status: response.status,
    expectStatus: step.expectStatus,
    expectResponseHeader: step.expectResponseHeader,
    passed: step.expectConnectionFailure ? false : statusMatches && headerMatches,
    body,
    headers,
  };
}

/** Builds and immediately fires an http request in one call - for callers with no separate preview stage. */
export async function runHttpStep(step, context) {
  const request = await buildHttpRequest(step, context);
  return executeHttpRequest(step, request);
}

/**
 * Fires `step.requestCount` requests and tallies responses - by `step.tallyBy`'s JSON
 * body field, or by HTTP status code when `tallyBy` is the sentinel '$status' (used for a
 * rate-limit burst, where a 429 may have no parseable JSON body). Defaults to a bodyless
 * GET; `step.method`/`step.body` let a traffic split exercise an AI route, which rejects a
 * bodyless request outright (it has no prompt to complete) rather than returning one.
 */
export async function runTrafficSplitStep(step, context) {
  const tally = {};
  const headers = await buildHeaders(step, context);
  const method = step.method || 'GET';
  const body = step.body;
  // Shown to the audience as-is (the logical request, same convention as an http step's
  // preview) - distinct from `target`, which is only used to actually fire it below.
  const request = { method, url: step.url, headers, ...(body !== undefined && { body }) };
  const target = await connectionTarget(step, step.url, headers);
  for (let i = 0; i < step.requestCount; i++) {
    const response = await fetch(target.url, {
      method,
      headers: target.headers,
      ...(body !== undefined && { body }),
      ...(target.tls && { tls: target.tls }),
    });
    const bucket =
      step.tallyBy === '$status'
        ? String(response.status)
        : ((await response.json())[step.tallyBy] ?? 'unknown');
    tally[bucket] = (tally[bucket] || 0) + 1;
  }
  return { kind: 'traffic-split', request, tally, requestCount: step.requestCount };
}
