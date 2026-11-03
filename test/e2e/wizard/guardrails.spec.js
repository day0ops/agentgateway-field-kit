// test/e2e/wizard/guardrails.spec.js
import { test, expect } from '@playwright/test';
import { gotoPillar, nextStep, applyPolicyIfNeeded, sendPreset } from './helpers.js';

test.describe('Guardrails pillar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await gotoPillar(page, /what gets through/i);
  });

  test('Prompt guard blocks SSNs and credit cards, lets safe questions through', async ({
    page,
  }) => {
    await applyPolicyIfNeeded(page);
    await test.step('safe question passes', async () => {
      const body = await sendPreset(page, 'Ask a safe question');
      expect(body).toContain('200');
    });
    await test.step('SSN mention is blocked', async () => {
      const body = await sendPreset(page, 'Mention an SSN');
      expect(body).toContain('403');
      expect(body).toContain('Request rejected due to policy violation');
    });
    await test.step('credit card ask is blocked', async () => {
      const body = await sendPreset(page, 'Ask for a credit card number');
      expect(body).toContain('403');
      expect(body).toContain('Request rejected due to policy violation');
    });
  });

  test("Banking inbound guardrail blocks fishing for another customer's data", async ({ page }) => {
    await nextStep(page);
    await applyPolicyIfNeeded(page);
    await test.step('safe banking question passes', async () => {
      const body = await sendPreset(page, 'Ask a safe banking question');
      expect(body).toContain('200');
    });
    await test.step("another customer's account data is blocked", async () => {
      const body = await sendPreset(page, "Ask for another customer's account data");
      expect(body).toContain('403');
      expect(body).toContain("bank policy prohibits requests for another customer's account data");
    });
  });

  test('Banking outbound guardrail keeps the account number from leaving', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);
    await applyPolicyIfNeeded(page);
    await test.step('safe authorized question passes', async () => {
      const body = await sendPreset(page, 'Ask a safe authorized question');
      expect(body).toContain('200');
    });
    await test.step('authorized account number never appears in the reply', async () => {
      const body = await sendPreset(page, 'Ask an authorized account question');
      expect(body).toContain('200');
      // The raw account number ("50473618299") must never leave, whether
      // agentgateway masks it or the model declines to repeat it back -
      // both are a correct outcome of this policy.
      expect(body).not.toContain('50473618299');
    });
  });
});
