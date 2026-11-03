import { test, expect } from '@playwright/test';
import { gotoPillar, nextStep, sendPreset } from './helpers.js';

test.describe('Routing pillar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await gotoPillar(page, /one endpoint, many models/i);
  });

  test('Model routing by name routes to the requested provider', async ({ page }) => {
    await test.step('Route to OpenAI', async () => {
      const body = await sendPreset(page, 'Route to OpenAI');
      expect(body).toContain('200');
      expect(body).toMatch(/"model":\s*"gpt-4o-mini/);
    });
    await test.step('Route to Anthropic', async () => {
      const body = await sendPreset(page, 'Route to Anthropic');
      expect(body).toContain('200');
      expect(body).toMatch(/"model":\s*"claude/);
    });
  });

  test('Dynamic routing picks a model by tier', async ({ page }) => {
    await nextStep(page);
    await test.step('Ask as fast tier', async () => {
      const body = await sendPreset(page, 'Ask as fast tier');
      expect(body).toContain('200');
      expect(body).toMatch(/"model":\s*"gpt-4o-mini/);
    });
    await test.step('Ask as premium tier', async () => {
      const body = await sendPreset(page, 'Ask as premium tier');
      expect(body).toContain('200');
      expect(body).toMatch(/"model":\s*"gpt-4o-2024/);
    });
  });

  test('Automatic fallback serves a real response', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);
    const body = await sendPreset(page, 'Send a request');
    expect(body).toContain('200');
    expect(body).toMatch(/"content":\s*"[^"]+"/);
  });

  test('Streaming responses arrive as incremental SSE chunks', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);
    await nextStep(page);
    const body = await sendPreset(page, 'Ask with streaming');
    expect(body).toContain('data:');
    expect((body.match(/"delta":/g) || []).length).toBeGreaterThan(1);
  });
});
