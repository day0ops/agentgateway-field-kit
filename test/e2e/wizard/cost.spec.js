// test/e2e/wizard/cost.spec.js
import { test, expect } from '@playwright/test';
import { gotoPillar, nextStep, applyPolicyIfNeeded, sendPreset } from './helpers.js';

test.describe('Cost pillar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await gotoPillar(page, /you can't govern what you can't see/i);
  });

  test('Cost attribution reports real token usage', async ({ page }) => {
    await applyPolicyIfNeeded(page);
    const body = await sendPreset(page, 'Ask through the priced route');
    expect(body).toContain('200');
    expect(body).toMatch(/"total_tokens":\s*\d+/);
  });

  test('Budgets: audit mode always lets the request through, block mode eventually 429s', async ({
    page,
  }) => {
    await nextStep(page);
    await applyPolicyIfNeeded(page);

    await test.step('team-alpha (audit) always succeeds', async () => {
      const body = await sendPreset(page, 'team-alpha asks (audit)');
      expect(body).toContain('200');
    });

    await test.step('team-beta (block) eventually returns 429 budget exceeded', async () => {
      let blocked = false;
      for (let i = 0; i < 5 && !blocked; i++) {
        const body = await sendPreset(page, 'team-beta asks (blocked)');
        if (body.includes('429')) {
          expect(body).toContain('budget exceeded');
          blocked = true;
        }
      }
      expect(blocked).toBe(true);
    });
  });

  test('Virtual keys: creating a key returns a usable sk- credential', async ({ page }) => {
    await nextStep(page);
    await applyPolicyIfNeeded(page);

    await page.locator('button:has-text("Create key")').first().click();
    await page
      .locator('input[name="name"], input[placeholder*="name" i]')
      .first()
      .fill('e2e-test-key');
    await page
      .locator('input[name="userId"], input[placeholder*="user" i]')
      .first()
      .fill('e2e-test-user');
    await page
      .locator('input[name="tokenBudget"], input[placeholder*="budget" i]')
      .first()
      .fill('100000');
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    await page.waitForTimeout(3000);

    const text = await page.locator('body').innerText();
    expect(text).toMatch(/sk-e2e-test-key-[0-9a-f]+/);
  });
});
