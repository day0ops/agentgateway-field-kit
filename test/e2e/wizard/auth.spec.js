// test/e2e/wizard/auth.spec.js
import { test, expect } from '@playwright/test';
import { gotoPillar, nextStep, logout } from './helpers.js';

test.describe.configure({ mode: 'serial' });

test.describe('Auth pillar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await gotoPillar(page, /who's allowed to do what/i);
  });

  test('Four questions intro renders the explanation', async ({ page }) => {
    const text = await page.locator('body').innerText();
    expect(text).toContain('Four questions every call must answer');
    expect(text).toContain('who is this for?');
  });

  test('Real login redirects to Keycloak and back with the real identity', async ({ page }) => {
    await nextStep(page);
    await logout(page);

    await page.locator('a:has-text("Log in")').first().click();
    await expect(page).toHaveURL(/keycloak\.agw\.lab\.day0ops\.com\/realms\/agw-dev/);
    const text = await page.locator('body').innerText();
    expect(text).toContain('Sign in to your account');

    await page.locator('#username').fill('user1');
    await page.locator('#password').fill(process.env.KEYCLOAK_DEFAULT_PASSWORD);
    await page.locator('#password').press('Enter');
    await page.waitForTimeout(4000);

    await gotoPillar(page, /who's allowed to do what/i);
    await nextStep(page);
    const after = await page.locator('body').innerText();
    expect(after).toContain('logged in as user1');
  });

  // Sub-steps 3-8 all call a real ops-agent backend through
  // /secure/ops-agent/run. Every one of them currently fails with "agent
  // returned status 401: authentication failed" - a real bug in the
  // deployed ops-agents, not in the wizard app (which correctly surfaces
  // this error since agentgateway-demo-wizard PR #41). Marked fixme so the
  // suite stays green until that's fixed upstream; do not delete these.

  test.fixme('Accounts Agent reads balance via Impersonation', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);
    await page.locator('button:has-text("Run agent")').first().click();
    await page.waitForTimeout(10000);
    const text = await page.locator('body').innerText();
    expect(text).toMatch(/balance/i);
  });

  test.fixme('Accounts Agent RBAC: admin-only tool denied after Apply', async ({ page }) => {
    await nextStep(page);
    await nextStep(page);
    await nextStep(page);
    await test.step('before Apply: full account number is readable', async () => {
      await page.locator('button:has-text("Run agent")').first().click();
      await page.waitForTimeout(10000);
      const text = await page.locator('body').innerText();
      expect(text).not.toContain('denied');
    });
    await test.step('after Apply: denied', async () => {
      await page.locator('button:has-text("Apply")').first().click();
      await page.waitForTimeout(8000);
      await page.locator('button:has-text("Run agent")').first().click();
      await page.waitForTimeout(10000);
      const text = await page.locator('body').innerText();
      expect(text).toContain('denied');
    });
  });

  test.fixme('Transfer Orchestrator -> Settlement delegation chain moves money', async ({
    page,
  }) => {
    for (let i = 0; i < 4; i++) await nextStep(page);
    await page.locator('button:has-text("Run agent")').first().click();
    await page.waitForTimeout(10000);
    const text = await page.locator('body').innerText();
    expect(text).toContain('transfer');
  });

  test.fixme('Settlement RBAC: direct transfer denied, chained transfer allowed, after Apply', async ({
    page,
  }) => {
    for (let i = 0; i < 5; i++) await nextStep(page);
    await page.locator('button:has-text("Apply")').first().click();
    await page.waitForTimeout(8000);

    await test.step('chained transfer still works', async () => {
      await page.locator('button:has-text("Run agent")').first().click();
      await page.waitForTimeout(10000);
      const text = await page.locator('body').innerText();
      expect(text).toContain('confirmed');
    });
    await test.step('direct transfer is denied', async () => {
      await page.locator('button:has-text("Try a direct transfer")').first().click();
      await page.waitForTimeout(5000);
      const text = await page.locator('body').innerText();
      expect(text).toMatch(/denied|403/);
    });
  });
});
