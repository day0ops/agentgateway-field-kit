/** Clicks the sidebar entry whose title matches pillarTitleRegex (e.g. /one endpoint, many models/i). */
export async function gotoPillar(page, pillarTitleRegex) {
  await page.locator(`text=${pillarTitleRegex}`).first().click();
}

export async function nextStep(page) {
  await page.locator('button:has-text("next")').first().click();
  await page.waitForTimeout(1000);
}

/**
 * Clicks "Apply" if the current step's policy shows "not applied", and
 * waits for the status to flip to "applied". A no-op if already applied -
 * safe to call unconditionally at the top of every policy-gated test.
 */
export async function applyPolicyIfNeeded(page) {
  const configureHeading = page.locator('text=CONFIGURE').first();
  const status = await configureHeading.locator('xpath=..').innerText();
  if (status.includes('not applied')) {
    await page.locator('button:has-text("Apply")').first().click();
    await page.locator('text=applied').first().waitFor({ timeout: 8000 });
  }
}

/**
 * Clicks a "REQUEST & RESPONSE" preset button by its exact title, sends it,
 * and returns the response pane's visible text (status line + body).
 * Always uses an EXACT match on "Send" - some preset titles (e.g. "Send a
 * request") contain the word "Send", which a substring match would catch
 * instead of the real submit button.
 */
export async function sendPreset(page, title) {
  await page.locator(`button:has-text("${title}")`).first().click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForTimeout(4000);
  const text = await page.locator('body').innerText();
  const idx = text.indexOf('BODY');
  return text.slice(idx);
}

/** True if the current page shows "logged in as <username>" in its LOG IN section. */
export async function isLoggedIn(page) {
  const text = await page.locator('body').innerText();
  return text.includes('logged in as');
}

/** Logs out via the real session (must be on the auth pillar's "Real login" step). */
export async function logout(page) {
  if (!(await isLoggedIn(page))) return;
  await page.locator('a:has-text("Log out")').first().click();
  await page.waitForTimeout(3000);
}

/**
 * Ensures a real Keycloak-authenticated session (not the wizard's demo-login
 * shortcut) for username/password. No-ops if already logged in. Must be
 * called while on the auth pillar's "Real login" step (sub-step 2), since
 * that's the only step the "Log in"/"Log out" links render on - callers
 * that need this for a later sub-step should call nextStep() once to reach
 * step 2, call this, then continue navigating to their target step.
 *
 * Each test calls this independently rather than relying on a shared
 * session from an earlier test: Playwright gives every test() a fresh,
 * isolated page/context by default, regardless of test.describe.configure's
 * serial mode - that setting only affects execution order and
 * fail-then-skip-subsequent behavior, never fixture sharing.
 *
 * No post-login re-navigation is needed here: confirmed live that
 * Keycloak's redirect-back URL carries `?returnTo=auth-login` (the "Real
 * login" step's own ID), and the wizard reads that to land back on this
 * exact sub-step automatically - the full-page OAuth round trip does not
 * lose pillar/step position.
 */
export async function ensureRealLogin(page, username, password) {
  if (await isLoggedIn(page)) return;
  await page.locator('a:has-text("Log in")').first().click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#password').press('Enter');
  await page.waitForTimeout(4000);
}
