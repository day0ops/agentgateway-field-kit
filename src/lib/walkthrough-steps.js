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
  let response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined && { body: request.body }),
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
  for (let i = 0; i < step.requestCount; i++) {
    const response = await fetch(step.url, {
      method,
      headers,
      ...(body !== undefined && { body }),
    });
    const bucket =
      step.tallyBy === '$status'
        ? String(response.status)
        : ((await response.json())[step.tallyBy] ?? 'unknown');
    tally[bucket] = (tally[bucket] || 0) + 1;
  }
  return { kind: 'traffic-split', tally, requestCount: step.requestCount };
}
