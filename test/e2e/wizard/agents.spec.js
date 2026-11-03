// test/e2e/wizard/agents.spec.js
import { test, expect } from '@playwright/test';
import { gotoPillar, nextStep, sendPreset } from './helpers.js';

test.describe('Agents pillar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await gotoPillar(page, /from models to agents/i);
  });

  test('Run agent calls the stock tool and returns a real price', async ({ page }) => {
    await page.locator('button:has-text("Run agent")').first().click();
    await page.waitForTimeout(12000);
    const text = await page.locator('body').innerText();
    expect(text).toContain('stock_get_stock_price');
    expect(text).toMatch(/\$\d+\.\d{2}/);
  });

  test('MCP authentication: tools/list works with and without a token', async ({ page }) => {
    await nextStep(page);
    await test.step('no token', async () => {
      const body = await sendPreset(page, 'List tools (no token)');
      expect(body).toMatch(/200|stock_get_stock_price/);
    });
    await test.step('team-alpha', async () => {
      const body = await sendPreset(page, 'List tools (team-alpha)');
      expect(body).toContain('stock_get_stock_price');
    });
  });

  test('Token exchange: calling MCP as team-alpha lists tools', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);
    const body = await sendPreset(page, 'Call MCP as team-alpha');
    expect(body).toContain('stock_get_stock_price');
  });

  test('Tool authZ: both teams can list tools through the multiplexed endpoint', async ({
    page,
  }) => {
    await nextStep(page);
    await nextStep(page);
    await nextStep(page);
    await test.step('team-alpha', async () => {
      const body = await sendPreset(page, 'team-alpha tools/list');
      expect(body).toContain('stock_get_stock_price');
    });
    await test.step('team-beta', async () => {
      const body = await sendPreset(page, 'team-beta tools/list');
      expect(body).toContain('stock_get_stock_price');
    });
  });
});
