# Wizard Playwright E2E Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an ad-hoc, manually-run Playwright suite that exercises the deployed `agentgateway-demo-wizard` web app end to end in a real browser, covering all 5 pillars' happy and negative paths, so a field engineer can confirm a live demo actually works before presenting it.

**Architecture:** One `playwright.config.js` at the repo root (baseURL from `WIZARD_URL`, retries off) plus `test/e2e/wizard/helpers.js` (shared navigation/login/preset-send helpers) and one `.spec.js` file per pillar. Each spec file is a `test.describe` block with one `test()` per sub-step, using `test.step()` for finer-grained actions within a sub-step. The auth pillar's tests share one browser context across the whole file so the real login established at sub-step 2 persists through sub-steps 3-8.

**Tech Stack:** `@playwright/test`, run via `npx playwright test` (or `bunx playwright test`) against a live cluster - this is NOT wired into CI.

## Global Constraints

- `WIZARD_URL` env var (no default) is the deployed wizard's hostname, e.g. `https://wizard.agw.lab.day0ops.com` - every test navigates relative to it via `playwright.config.js`'s `baseURL`.
- `KEYCLOAK_DEFAULT_PASSWORD` env var (already required elsewhere in this repo) is the password for Keycloak user `user1` (team-alpha), used by the auth pillar's real-login test.
- `PAYPAL_SANDBOX_EMAIL` / `PAYPAL_SANDBOX_PASSWORD` env vars (new) are the PayPal sandbox buyer account credentials for the Interactive Elicitation sub-step's real redirect.
- The submit button in every "REQUEST & RESPONSE" preset panel is always `page.getByRole('button', { name: 'Send', exact: true })` - a plain `has-text('Send')` locator also matches preset titles containing the word "Send" (e.g. "Send a request"), picking the wrong element. Always use the exact-match form.
- A policy's "Apply" button flips its status text from `not applied` to `applied` (and the button itself from `Apply` to `Revert`) only after the cluster reconciles - allow up to 8s after clicking before asserting or sending a preset that depends on it.
- Never hardcode PayPal/Stripe credentials or tokens in test files - read them from `process.env` only.
- **Known gap, out of scope for this plan:** every OpsAgent "Run agent" action in the auth pillar (sub-steps 3-8: Accounts, Transfer Orchestrator/Settlement, Statements via PayPal, Statements via Stripe) currently fails with `agent returned status 401: authentication failed` - a real bug in the deployed ops-agents backend unrelated to the wizard app itself (tracked informally; no issue filed in this repo since the fix lives in a different image/repo). Tests for these sub-steps are written to assert the _documented, correct_ behavior and marked `test.fixme()` with a comment pointing at this gap, so the suite stays green until it's fixed upstream - do not delete or water down these tests to work around it.

---

### Task 1: Playwright project setup

**Files:**

- Create: `playwright.config.js`
- Modify: `package.json` (add `"test:e2e": "playwright test"` script and `@playwright/test` devDependency)
- Modify: `CLAUDE.md` (document the 3 new env vars in the existing env var list, per this repo's env-var-docs-sync convention)

**Interfaces:**

- Produces: `playwright.config.js`'s exported config, consumed by every spec file via `@playwright/test`'s own `test`/`expect` imports (no local re-export needed).

- [ ] **Step 1: Install the Playwright test package**

Run: `bun add -d @playwright/test`

- [ ] **Step 2: Write playwright.config.js**

```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e/wizard',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.WIZARD_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
```

- [ ] **Step 3: Add the test:e2e script to package.json**

In `package.json`'s `"scripts"` block, add:

```json
"test:e2e": "playwright test"
```

- [ ] **Step 4: Verify the config loads with no spec files yet**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test`
Expected: `Error: No tests found` (confirms the config itself is valid - there's nothing to run yet, which is the correct "red" state before any spec file exists)

- [ ] **Step 5: Document the new env vars in CLAUDE.md**

In `CLAUDE.md`'s `## Environment variables` code block, add these three lines in the same style as the existing entries (after the `GITHUB_ISSUER_CLIENT_ID`/`GITHUB_ISSUER_CLIENT_SECRET` pair, since both are also real-redirect OAuth test credentials):

```bash
export WIZARD_URL=                     # agentgateway-demo-wizard E2E suite - the deployed wizard's hostname, e.g. https://wizard.agw.lab.day0ops.com
export PAYPAL_SANDBOX_EMAIL=           # agentgateway-demo-wizard E2E suite's Interactive Elicitation test - PayPal sandbox buyer account
export PAYPAL_SANDBOX_PASSWORD=
```

- [ ] **Step 6: Commit**

```bash
git add playwright.config.js package.json CLAUDE.md
git commit -m "test(e2e): add Playwright project setup for the wizard E2E suite"
```

---

### Task 2: Shared test helpers

**Files:**

- Create: `test/e2e/wizard/helpers.js`

**Interfaces:**

- Produces, for every later task to import via `import { ... } from './helpers.js'`:
  - `gotoPillar(page, pillarTitleRegex)` - `Promise<void>`
  - `nextStep(page)` - `Promise<void>`
  - `applyPolicyIfNeeded(page)` - `Promise<void>`
  - `sendPreset(page, title)` - `Promise<string>` (returns the response pane's visible text)
  - `logout(page)` - `Promise<void>`
  - `isLoggedIn(page)` - `Promise<boolean>`

- [ ] **Step 1: Write helpers.js**

```js
// test/e2e/wizard/helpers.js

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
```

- [ ] **Step 2: Commit**

```bash
git add test/e2e/wizard/helpers.js
git commit -m "test(e2e): add shared navigation/login/preset helpers"
```

---

### Task 3: Routing pillar spec (4 sub-steps)

**Files:**

- Create: `test/e2e/wizard/routing.spec.js`

**Interfaces:**

- Consumes: `gotoPillar`, `nextStep`, `sendPreset` from `./helpers.js`.

- [ ] **Step 1: Write routing.spec.js**

All 4 of this pillar's steps are "pre-provisioned" (no Apply needed - confirmed live, `CONFIGURE` shows `View config` / `pre-provisioned` on every step).

```js
// test/e2e/wizard/routing.spec.js
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
```

- [ ] **Step 2: Run it against the live deployment**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test routing.spec.js`
Expected: 4 passed

- [ ] **Step 3: Commit**

```bash
git add test/e2e/wizard/routing.spec.js
git commit -m "test(e2e): add routing pillar spec"
```

---

### Task 4: Guardrails pillar spec (3 sub-steps)

**Files:**

- Create: `test/e2e/wizard/guardrails.spec.js`

**Interfaces:**

- Consumes: `gotoPillar`, `nextStep`, `applyPolicyIfNeeded`, `sendPreset` from `./helpers.js`.

- [ ] **Step 1: Write guardrails.spec.js**

Every sub-step's own policy must be applied first - confirmed live, including the full apply → block → revert → unblock lifecycle (`agentgateway-demo-wizard` PRs #39/#40 fixed a real bug where sub-steps 2-3's policies were silently never enforced before this).

```js
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
```

- [ ] **Step 2: Run it against the live deployment**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test guardrails.spec.js`
Expected: 3 passed

- [ ] **Step 3: Commit**

```bash
git add test/e2e/wizard/guardrails.spec.js
git commit -m "test(e2e): add guardrails pillar spec"
```

---

### Task 5: Cost pillar spec (2 sub-steps + virtual keys)

**Files:**

- Create: `test/e2e/wizard/cost.spec.js`

**Interfaces:**

- Consumes: `gotoPillar`, `nextStep`, `applyPolicyIfNeeded`, `sendPreset` from `./helpers.js`.

- [ ] **Step 1: Write cost.spec.js**

team-beta's budget is deliberately tiny and may already be exhausted from a previous run of this same test (budgets persist on the cluster across test runs) - the test calls it in a retry loop rather than asserting 429 on the very first call, which is the only way to make this assertion deterministic regardless of prior state.

```js
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
```

- [ ] **Step 2: Run it against the live deployment**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test cost.spec.js`
Expected: 3 passed. If the virtual-keys test fails on its input selectors, the exact field names/placeholders weren't confirmed live during planning (the "Create key" form was reached but not filled in) - inspect the live form's actual `<input>` attributes via the browser devtools or `page.locator('input').evaluateAll(els => els.map(e => ({name: e.name, placeholder: e.placeholder, id: e.id})))` and adjust the 3 selectors above to match.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/wizard/cost.spec.js
git commit -m "test(e2e): add cost pillar spec"
```

---

### Task 6: Agents pillar spec (4 sub-steps)

**Files:**

- Create: `test/e2e/wizard/agents.spec.js`

**Interfaces:**

- Consumes: `gotoPillar`, `nextStep`, `sendPreset` from `./helpers.js`.

- [ ] **Step 1: Write agents.spec.js**

Sub-step 1's `/api/agent/run` endpoint and sub-steps 2-4's raw MCP presets were both fixed this session (`agentgateway-demo-wizard` PRs #35-#38: official MCP SDK, multiplexed-target tool name prefixes, the MCP Accept header, and the MCP session handshake for raw presets) and verified live, repeatedly, on fresh deploys.

```js
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
```

- [ ] **Step 2: Run it against the live deployment**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test agents.spec.js`
Expected: 4 passed

- [ ] **Step 3: Commit**

```bash
git add test/e2e/wizard/agents.spec.js
git commit -m "test(e2e): add agents pillar spec"
```

---

### Task 7: Auth pillar spec (8 sub-steps, shared login session)

**Files:**

- Create: `test/e2e/wizard/auth.spec.js`

**Interfaces:**

- Consumes: `gotoPillar`, `nextStep`, `logout` from `./helpers.js`.
- All tests in this file share one browser context (Playwright's default within a single file run serially) so the real login from sub-step 2 persists through sub-steps 3-8.

- [ ] **Step 1: Write the intro and real-login tests (sub-steps 1-2)**

```js
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
```

- [ ] **Step 2: Run these two tests against the live deployment**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test auth.spec.js`
Expected: 2 passed

- [ ] **Step 3: Commit**

```bash
git add test/e2e/wizard/auth.spec.js
git commit -m "test(e2e): add auth pillar intro and real-login tests"
```

- [ ] **Step 4: Add the OpsAgent-dependent tests (sub-steps 3-6), marked fixme per the known gap**

Append to `test/e2e/wizard/auth.spec.js`, inside the same `test.describe('Auth pillar', ...)` block:

```js
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

test.fixme('Transfer Orchestrator -> Settlement delegation chain moves money', async ({ page }) => {
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
```

- [ ] **Step 5: Run to confirm these 4 are reported as fixme, not failed**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test auth.spec.js`
Expected: 2 passed, 4 fixme (Playwright reports fixme tests separately from pass/fail - a fixme test that unexpectedly passes is flagged, which is exactly the signal needed once the upstream bug is fixed)

- [ ] **Step 6: Commit**

```bash
git add test/e2e/wizard/auth.spec.js
git commit -m "test(e2e): add auth pillar RBAC/delegation tests (fixme pending ops-agent bug)"
```

- [ ] **Step 7: Add the PayPal/Stripe elicitation tests (sub-steps 7-8), also fixme**

These two sub-steps are blocked by the same upstream ops-agent bug one layer earlier than the RBAC tests - "Run agent" never even reaches the point of returning a consent URL, so PayPal's and Stripe's own page selectors were never reached live during planning. Append to the same file:

```js
// Blocked by the same upstream bug as the tests above - "Run agent" never
// gets far enough to return a consent URL, so PayPal's/Stripe's own page
// selectors were never reached live. Once PR #41's root cause (the
// ops-agent auth failure) is fixed, implement these by: running the
// agent, extracting the consent URL from the response text, opening it,
// and grounding the exact field selectors directly against the live page
// at that time - PayPal's sandbox login is a third-party page outside
// this repo's control and its selectors were never verified here.

test.fixme('Statements Agent -> PayPal Interactive elicitation', async ({ page }) => {
  for (let i = 0; i < 6; i++) await nextStep(page);
  await page.locator('button:has-text("Run agent")').first().click();
  await page.waitForTimeout(10000);
  const text = await page.locator('body').innerText();
  const consentLink = text.match(/https:\/\/[^\s]+/)?.[0];
  expect(consentLink).toBeTruthy();
  await page.goto(consentLink);
  expect(page.url()).toContain('paypal.com');
});

test.fixme('Statements Agent -> Stripe Brokered elicitation', async ({ page }) => {
  for (let i = 0; i < 7; i++) await nextStep(page);
  await page.locator('button:has-text("Run agent")').first().click();
  await page.waitForTimeout(10000);
  const text = await page.locator('body').innerText();
  expect(text).toMatch(/stripe|payout/i);
});
```

- [ ] **Step 8: Run the full auth spec**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test auth.spec.js`
Expected: 2 passed, 6 fixme

- [ ] **Step 9: Commit**

```bash
git add test/e2e/wizard/auth.spec.js
git commit -m "test(e2e): add auth pillar PayPal/Stripe elicitation tests (fixme pending ops-agent bug)"
```

---

### Task 8: Full suite run and self-review

**Files:** none (verification only)

- [ ] **Step 1: Run the entire suite**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test`
Expected: 13 passed, 6 fixme, 0 failed (4 routing + 3 guardrails + 3 cost + 4 agents + 2 auth = 16 real assertions passing; 6 auth sub-steps fixme pending the known ops-agent gap)

- [ ] **Step 2: Re-run guardrails.spec.js a second time in the same session**

Run: `WIZARD_URL=https://wizard.agw.lab.day0ops.com bunx playwright test guardrails.spec.js`
Expected: still 3 passed - confirms `applyPolicyIfNeeded`'s no-op-when-already-applied path works, matching the idempotent merge-apply fix from PR #40.

- [ ] **Step 3: Commit if any fixups were needed**

If step 1 or 2 required any selector/assertion fixes, commit them now with a message describing what was wrong (e.g. `test(e2e): fix virtual-keys form selectors found during full suite run`).
