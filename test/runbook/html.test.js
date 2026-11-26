import { test, expect, describe } from 'bun:test';
import { HtmlRenderer } from '../../src/lib/runbook-html.js';
import { RunbookBuilder } from '../../src/lib/runbook.js';

const SAMPLE_MD = [
  '# Sample Runbook',
  '',
  '---',
  '',
  '## Prerequisites',
  '',
  'Install tools.',
  '',
  '---',
  '',
  '## Lab 0: Installation',
  '',
  'Some setup text.',
  '',
  '### Step 1: Do a thing',
  '',
  '```bash',
  'echo hi',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '---',
  '',
  '## Cleanup',
  '',
  'Tear it down.',
].join('\n');

describe('HtmlRenderer', () => {
  test('render() produces a standalone HTML page', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, { title: 'Sample Runbook', usecases: [] });
    expect(typeof html).toBe('string');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Sample Runbook - Runbook</title>');
    expect(html).toContain('<h1>Sample Runbook</h1>');
  });

  test('render() wraps each top-level section in a collapsible lab card', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, { title: 'T', usecases: [] });
    expect(html).toContain('<details class="lab" id="lab-0"');
    expect(html).toContain('id="prerequisites"');
    expect(html).toContain('id="cleanup"');
  });

  test('render() converts mermaid fences to <pre class="mermaid"> not code blocks', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, { title: 'T', usecases: [] });
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('graph TD; A--&gt;B;');
    expect(html).not.toContain('language-mermaid');
  });

  test('render() references the mermaid and highlight.js CDNs', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, { title: 'T', usecases: [] });
    expect(html).toContain('mermaid@11');
    expect(html).toContain('highlight.min.js');
  });

  test('render() omits the hero when no single use case is selected', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, { title: 'T', usecases: [] });
    expect(html).not.toContain('class="hero"');
  });

  test('render() shows a hero titled from the use case description for a single use case', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, {
      title: 'T',
      usecases: [
        { metadata: { name: 'my-uc', description: 'Do a thing.\nmore detail' }, spec: {} },
      ],
    });
    expect(html).toContain('class="hero"');
    expect(html).toContain('Do a thing');
  });

  test('render() wraps a Test It subsection in a bordered test-case box with meta/request/expect regions', () => {
    const md = [
      '# T',
      '',
      '## Lab 1: Something',
      '',
      '### Test It',
      '',
      '#### My Test',
      '',
      'A description.',
      '',
      '> **Setup:** `scale-deployment`: replicas=0',
      '',
      '**Send:**',
      '',
      '```bash',
      'curl -s -X POST "http://example" -d \'{"a":1}\'',
      '```',
      '',
      '**Expect:** status=success',
      '',
      '> **Teardown:** `scale-deployment`: replicas=1',
      '',
    ].join('\n');
    const html = new HtmlRenderer().render(md, { title: 'T', usecases: [] });

    expect(html).not.toContain('@@TEST_CASE@@');
    expect(html).not.toContain('@@TEST_META@@');
    expect(html).not.toContain('@@TEST_REQUEST@@');
    expect(html).not.toContain('@@TEST_EXPECT@@');

    expect(html).toContain('<div class="test-case">');
    const caseIdx = html.indexOf('<div class="test-case">');
    const headingIdx = html.indexOf('<h4 id="my-test">My Test</h4>');
    const metaIdx = html.indexOf('<div class="test-case-meta">');
    const requestIdx = html.indexOf('<div class="test-case-request">');
    const codeIdx = html.indexOf('curl -s -X POST');
    const expectIdx = html.indexOf('<div class="test-case-expect">');

    expect(caseIdx).toBeGreaterThan(-1);
    expect(headingIdx).toBeGreaterThan(caseIdx);
    expect(metaIdx).toBeGreaterThan(headingIdx);
    expect(requestIdx).toBeGreaterThan(metaIdx);
    expect(codeIdx).toBeGreaterThan(requestIdx);
    expect(expectIdx).toBeGreaterThan(codeIdx);

    // Setup lands inside meta, teardown inside expect.
    expect(html.indexOf('Setup:')).toBeGreaterThan(metaIdx);
    expect(html.indexOf('Setup:')).toBeLessThan(requestIdx);
    expect(html.indexOf('Teardown:')).toBeGreaterThan(expectIdx);
  });

  test('render() with no Test It section emits no test-case markup', () => {
    const html = new HtmlRenderer().render(SAMPLE_MD, { title: 'T', usecases: [] });
    expect(html).not.toContain('<div class="test-case">');
  });
});

describe('RunbookBuilder.buildHtml', () => {
  test('buildHtml() returns a standalone HTML document for the runbook', async () => {
    const builder = new RunbookBuilder({ title: 'HTML Test', addons: [], providers: [], labs: [] });
    const html = await builder.buildHtml();
    expect(typeof html).toBe('string');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<h1>HTML Test</h1>');
    expect(html).toContain('id="lab-0"');
    expect(html).toContain('mermaid@11');
  });

  test('build() and buildHtml() reuse the same assembled markdown', async () => {
    const builder = new RunbookBuilder({
      title: 'Reuse Test',
      addons: [],
      providers: [],
      labs: [],
    });
    const md = await builder.build();
    const html = await builder.buildHtml();
    expect(md.startsWith('# Reuse Test')).toBe(true);
    // A heading present in the markdown must survive into the HTML sidenav/sections.
    expect(md).toContain('## Cleanup');
    expect(html).toContain('id="cleanup"');
  });
});
