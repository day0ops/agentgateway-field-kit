// test/e2e/wizard/tenants.spec.js
//
// Requires a live deployed cluster with the Task 1 usecase applied (the
// dedicated "agentgateway-tenants" Gateway and its JWT/CEL/budget policies).
// Not runnable in a sandboxed/local-only session - pending the first real
// deploy, same constraint the design doc states for this pillar.
import { test, expect } from '@playwright/test';
import { gotoPillar, nextStep, sendPreset } from './helpers.js';

test.describe('Tenants pillar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await gotoPillar(page, /one route, three tenants, zero crossover/i);
  });

  test('Intro explains entitlement vs identity', async ({ page }) => {
    const text = await page.locator('body').innerText();
    expect(text).toContain('Entitlement, not just identity');
    expect(text).toContain('acme and globex are entitled, initech is not');
  });

  test('Entitlement: deny-by-default, verified org not spoofed headers, invalid JWT rejected', async ({
    page,
  }) => {
    await nextStep(page);

    await test.step('initech is denied (real login, not entitled)', async () => {
      const body = await sendPreset(page, 'initech asks (denied)');
      expect(body).toContain('403');
    });

    await test.step('acme is allowed (entitled)', async () => {
      const body = await sendPreset(page, 'acme asks (entitled)');
      expect(body).toContain('200');
    });

    await test.step("initech forging acme's header is still denied", async () => {
      const body = await sendPreset(page, "initech forges acme's header (still denied)");
      expect(body).toContain('403');
    });

    await test.step("initech's forged header is overwritten on the unprotected echo route", async () => {
      const body = await sendPreset(page, "initech's forged header, overwritten (echo)");
      expect(body).toContain('200');
    });

    await test.step('a request with no valid JWT never reaches the entitlement check', async () => {
      const body = await sendPreset(page, 'Invalid JWT (rejected)');
      expect(body).toContain('401');
    });
  });

  test('Budgets: acme healthy, globex exhausted, fully independent', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);

    await test.step('acme asks with a healthy budget', async () => {
      const body = await sendPreset(page, 'acme asks (budget healthy)');
      expect(body).toContain('200');
    });

    await test.step("globex's exhausted budget blocks the identical request", async () => {
      const body = await sendPreset(page, 'globex asks (budget exhausted)');
      expect(body).toContain('429');
    });
  });
});
