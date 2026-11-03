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
});
