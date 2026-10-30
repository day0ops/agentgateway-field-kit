#!/usr/bin/env bun
/**
 * Manual demo for the jev-cost-tier-routing usecase
 * (config/usecases/enterprise/routing/jev/jev-cost-tier-routing.yaml).
 *
 * Two hops, both through the gateway:
 *   1. POST /jev    - Jev classifies the prompt as "cheap" or "premium"
 *   2. POST /model  - routed completion using that alias
 *
 * Usage:
 *   bun scripts/jev-routing-demo.js
 *   bun scripts/jev-routing-demo.js --prompt "What's 2+2?"
 *   bun scripts/jev-routing-demo.js --host localhost --port 8080
 */

import { EDITION_GATEWAY_NAME } from '../src/lib/editions.js';
import { UseCaseTestRunner } from '../src/lib/usecase-tests.js';

const DEFAULT_PROMPT =
  'Design a distributed consensus protocol that tolerates Byzantine faults and prove its safety property.';

function parseArgs(argv) {
  const args = {
    namespace: process.env.AGENTGATEWAY_NAMESPACE || 'agentgateway-system',
    gatewayName: EDITION_GATEWAY_NAME.enterprise,
    port: 8080,
    host: null,
    prompt: DEFAULT_PROMPT,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split('=');
    const next = () => inlineValue ?? argv[++i];
    switch (flag) {
      case '--namespace':
        args.namespace = next();
        break;
      case '--gateway-name':
        args.gatewayName = next();
        break;
      case '--port':
        args.port = Number(next());
        break;
      case '--host':
        args.host = next();
        break;
      case '--prompt':
        args.prompt = next();
        break;
      case '--help':
        printUsageAndExit();
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        printUsageAndExit(1);
    }
  }
  return args;
}

function printUsageAndExit(code = 0) {
  console.log(`
Usage: bun scripts/jev-routing-demo.js [options]

  --prompt <text>       Prompt to classify and route (default: a complex sample prompt)
  --host <host>         Gateway host/IP (skips the kubectl LoadBalancer lookup)
  --port <port>         Gateway port (default: 8080)
  --namespace <ns>      Gateway namespace (default: agentgateway-system)
  --gateway-name <name> Gateway Service name (default: ${EDITION_GATEWAY_NAME.enterprise})
`);
  process.exit(code);
}

/**
 * Jev's request/response field names (state/model/questions, answers[].option/confidence)
 * are inferred from secondary sources, not TypeSafe's primary API reference - confirm
 * against a real account and adjust this function if the real shape differs.
 */
async function classify(baseUrl, prompt) {
  const start = performance.now();
  const res = await fetch(`${baseUrl}/jev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: prompt,
      model: 'jev-latest',
      questions: [
        {
          name: 'tier',
          type: 'select',
          prompt:
            'Does answering this well require deep multi-step reasoning (premium), or is it a simple/routine request (cheap)?',
          options: ['cheap', 'premium'],
        },
      ],
    }),
  });
  const latencyMs = performance.now() - start;
  if (!res.ok) {
    throw new Error(`Jev classification failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const tier = body.answers?.[0]?.option ?? body.option ?? body.choice;
  const confidence = body.answers?.[0]?.confidence ?? body.confidence;
  return { tier, confidence, latencyMs };
}

async function complete(baseUrl, tier, prompt) {
  const start = performance.now();
  const res = await fetch(`${baseUrl}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tier, messages: [{ role: 'user', content: prompt }] }),
  });
  const latencyMs = performance.now() - start;
  if (!res.ok) {
    throw new Error(`Routed completion failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const answer = body.choices?.[0]?.message?.content ?? JSON.stringify(body);
  return { answer, latencyMs };
}

const args = parseArgs(process.argv.slice(2));
const host =
  args.host || (await UseCaseTestRunner.getGatewayAddress(args.namespace, args.gatewayName));
const baseUrl = `http://${host}:${args.port}`;

console.log(`Prompt: ${args.prompt}\n`);

try {
  const { tier, confidence, latencyMs: decisionLatency } = await classify(baseUrl, args.prompt);
  console.log(
    `Jev decision: ${tier} (confidence: ${confidence})  [${decisionLatency.toFixed(0)}ms]`
  );

  const { answer, latencyMs: completionLatency } = await complete(baseUrl, tier, args.prompt);
  console.log(`Routed to: ${tier}  [${completionLatency.toFixed(0)}ms]`);
  console.log(`\nResponse:\n${answer}`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
