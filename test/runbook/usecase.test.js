// test/runbook/usecase.test.js
import { test, expect, describe } from 'bun:test';
import { mkdtempSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseAdapter } from '../../src/lib/runbook-adapters/usecase.js';

describe('UseCaseAdapter', () => {
  test('generate(apikey-auth) returns Lab N heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 2:');
  });

  test('generate(apikey-auth) contains sequence diagram fenced block', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(apikey-auth) still shows the Lab 1 prerequisite banner', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('Lab 1');
  });

  test('generate(apikey-auth) renders the providers feature YAML rather than skipping it', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    // A usecase's own providers config (e.g. realtime route types, http.version) can
    // diverge from whatever was deployed in Lab 1, so it must always be rendered -
    // never silently assumed redundant.
    expect(section).not.toContain('No action required');
    expect(section).toContain('EnterpriseAgentgatewayBackend');
  });

  test('generate(apikey-auth) contains step headings', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('### Step');
  });

  test('generate(apikey-auth) contains yaml blocks from dryRun or sidecar', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'apikey-auth',
      labNum: 2,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```yaml');
  });

  test('generate() with empty-root projectRoot throws for valid use case (not found in empty dir)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'uc-root-'));
    await mkdir(join(tmpRoot, 'config', 'usecases'), { recursive: true });
    try {
      await expect(
        UseCaseAdapter.generate({
          name: 'apikey-auth',
          labNum: 2,
          deployedProviders: [],
          projectRoot: tmpRoot,
        })
      ).rejects.toThrow();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('generate throws for unknown use case', async () => {
    await expect(
      UseCaseAdapter.generate({ name: 'nonexistent-use-case', labNum: 2, deployedProviders: [] })
    ).rejects.toThrow();
  });

  test('generate(openai-model-aliasing) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'openai-model-aliasing',
      labNum: 5,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 5:');
  });

  test('generate(openai-model-aliasing) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'openai-model-aliasing',
      labNum: 5,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(p2c-load-balancing) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'p2c-load-balancing',
      labNum: 6,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 6:');
  });

  test('generate(p2c-load-balancing) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'p2c-load-balancing',
      labNum: 6,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(gemini-streaming) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'gemini-streaming',
      labNum: 7,
      deployedProviders: ['gemini'],
    });
    expect(section).toContain('## Lab 7:');
  });

  test('generate(gemini-streaming) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'gemini-streaming',
      labNum: 7,
      deployedProviders: ['gemini'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(dynamic-user-context) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'dynamic-user-context',
      labNum: 8,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 8:');
  });

  test('generate(dynamic-user-context) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'dynamic-user-context',
      labNum: 8,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(token-cap) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-cap',
      labNum: 9,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 9:');
  });

  test('generate(token-cap) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-cap',
      labNum: 9,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(header-access-control) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'header-access-control',
      labNum: 10,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 10:');
  });

  test('generate(header-access-control) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'header-access-control',
      labNum: 10,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(per-key-token-budget) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'per-key-token-budget',
      labNum: 11,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 11:');
  });

  test('generate(per-key-token-budget) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'per-key-token-budget',
      labNum: 11,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(token-usage-monitoring) returns Lab heading', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-usage-monitoring',
      labNum: 12,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('## Lab 12:');
  });

  test('generate(token-usage-monitoring) contains sequence diagram', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'token-usage-monitoring',
      labNum: 12,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('```mermaid');
    expect(section).toContain('sequenceDiagram');
  });

  test('generate(f5-guardrail) renders spec.tests as a Test It section (no companion .md)', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'enterprise/guardrail/f5-guardrail',
      labNum: 1,
      deployedProviders: ['openai'],
    });
    expect(section).toContain('### Test It');
    expect(section).toContain('#### Allow Safe Request');
    expect(section).toContain('**Send:**');
    expect(section).toContain('curl -s -X POST "http://${AGW_GATEWAY_HOST}:8080/openai"');
    expect(section).toContain(
      '-d \'{"messages":[{"role":"user","content":"What is your favorite poem?"}]}\''
    );
    expect(section).toContain('**Expect:** status=success');
    expect(section).toContain('#### Block Banned Phrase');
    expect(section).toContain('**Expect:** status=blocked, reason="keyword-scanner"');
  });

  test('generate(timeouts-and-retries) renders setup/teardown steps in Test It', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'timeouts-and-retries',
      labNum: 1,
      deployedProviders: [],
    });
    expect(section).toContain('### Test It');
    expect(section).toContain('**Setup:** `scale-deployment`: name=mock-openai, replicas=0');
    expect(section).toContain('**Teardown:** `scale-deployment`: name=mock-openai, replicas=1');
  });

  test('curl rendering: headers forward, GET omits body/Content-Type, embedded quotes are shell-escaped', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'uc-curl-render-'));
    const usecaseDir = join(tmpRoot, 'config', 'usecases', 'enterprise', 'curl-render-test');
    await mkdir(usecaseDir, { recursive: true });
    await writeFile(
      join(usecaseDir, 'curl-render-test.yaml'),
      [
        'apiVersion: agentgateway.demo/v1',
        'kind: UseCase',
        'metadata:',
        '  name: curl-render-test',
        'spec:',
        '  features: []',
        '  tests:',
        '    - name: quoting-and-headers',
        '      steps:',
        '        - action: send-request',
        '          endpoint: /openai',
        '          prompt: "What\'s up?"',
        '          headers:',
        '            Authorization: Bearer test-token',
        '        - action: verify',
        '          expect:',
        '            status: success',
        '    - name: get-request',
        '      steps:',
        '        - action: send-request',
        '          endpoint: /v1/models',
        '          method: GET',
        '        - action: verify',
        '          expect:',
        '            status: success',
        '    - name: query-string-endpoint',
        '      steps:',
        '        - action: send-request',
        '          endpoint: /openai?model=gpt-4o',
        '          prompt: hi',
        '        - action: verify',
        '          expect:',
        '            status: success',
        '    - name: env-var-header',
        '      steps:',
        '        - action: send-request',
        '          endpoint: /openai',
        '          prompt: hi',
        '          headers:',
        "            Authorization: 'Bearer ${OPENAI_API_KEY}'",
        '        - action: verify',
        '          expect:',
        '            status: success',
        '    - name: bearer-auth',
        '      steps:',
        '        - action: get-token',
        '        - action: send-request',
        '          endpoint: /chat',
        '          prompt: hi',
        '          auth: bearer',
        '        - action: verify',
        '          expect:',
        '            status: success',
        '    - name: sni-resolve',
        '      steps:',
        '        - action: send-request',
        '          endpoint: /',
        '          prompt: hi',
        '          scheme: https',
        '          port: 8443',
        '          resolve:',
        '            hostname: alpha.sni-demo.local',
        '        - action: verify',
        '          expect:',
        '            status: success',
        '',
      ].join('\n')
    );
    try {
      const section = await UseCaseAdapter.generate({
        name: 'curl-render-test',
        labNum: 1,
        deployedProviders: [],
        projectRoot: tmpRoot,
      });
      expect(section).toContain(
        '-d \'{"messages":[{"role":"user","content":"What\'\\\'\'s up?"}]}\''
      );
      expect(section).toContain("-H 'Authorization: Bearer test-token'");
      expect(section).toContain('curl -s -X GET "http://${AGW_GATEWAY_HOST}:8080/v1/models"');
      expect(section).not.toContain('GET "http://${AGW_GATEWAY_HOST}:8080/v1/models" \\');
      expect(section).toContain(
        'curl -s -X POST "http://${AGW_GATEWAY_HOST}:8080/openai?model=gpt-4o"'
      );
      expect(section).toContain('-H "Authorization: Bearer ${OPENAI_API_KEY}"');
      expect(section).toContain(
        "-H 'Authorization: Bearer <token from an earlier get-token step>'"
      );
      expect(section).toContain('--connect-to alpha.sni-demo.local:8443:${AGW_GATEWAY_HOST}:8443');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('generate(agent-workload-identity) still prefers the companion .md Running section over spec.tests', async () => {
    const section = await UseCaseAdapter.generate({
      name: 'agent-workload-identity',
      labNum: 1,
      deployedProviders: [],
    });
    expect(section).toContain('### Test It');
    // The companion .md's hand-written curl walkthrough, not the generic renderer.
    expect(section).toContain('caller-agent/run');
  });
});
