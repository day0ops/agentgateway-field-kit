# Wizard Playwright E2E test - design

## Goal

An ad-hoc, manually-run Playwright test suite that exercises the deployed `agentgateway-demo-wizard` web app (the `demo-wizard/agentgateway-demo-wizard` usecase) end to end in a real browser, so a field engineer can confirm a live demo actually works before presenting it - catching the kind of regression this session already hit live (a self-signed cert silently breaking the TLS-verified reachability check, a stale demo-user password silently breaking the real login step).

## Scope

Full exhaustive walkthrough of all 5 pillars the wizard demonstrates, happy-path plus the explicitly-called-out negative paths, including both external elicitation flows (PayPal's real redirect, Stripe's inline brokered approval). Not a CI gate - no new `agw` subcommand, no CI workflow wiring. Just a Playwright suite run directly against whatever cluster is currently deployed.

## Architecture

```
playwright.config.js                    # root config: baseURL from WIZARD_URL env var, timeouts, retries=0
test/e2e/wizard/
  helpers.js                            # shared: step navigation, Keycloak login, wait-for-response
  routing.spec.js                       # pillar 1: One endpoint, many models (4 sub-steps)
  auth.spec.js                          # pillar 2: Who's allowed to do what (8 sub-steps)
  guardrails.spec.js                    # pillar 3: What gets through (3 sub-steps)
  cost.spec.js                          # pillar 4: You can't govern what you can't see (2 sub-steps)
  agents.spec.js                        # pillar 5: From models to agents (4 sub-steps)
```

Each spec file is a `test.describe` block for its pillar, with one `test()` per sub-step or logical group of sub-steps, using Playwright's `test.step()` to label the finer-grained actions within a sub-step (apply policy, run before, run after). **Correction made during implementation:** this section originally stated the auth pillar's tests would share a single browser context so sub-step 2's login persists through sub-steps 3-8. Playwright gives every `test()` a fresh, isolated `page`/context by default regardless of file/serial execution order, so that never actually happens. The implementation instead has each of `auth.spec.js`'s auth-dependent tests independently call an `ensureRealLogin` helper.

## Config & credentials

New required env vars (to be documented in CLAUDE.md alongside the existing list, per this repo's env-var-docs-sync convention):

- `WIZARD_URL` - the deployed wizard's hostname, e.g. `https://wizard.agw.lab.day0ops.com`. No default; always a specific live deployment.
- `PAYPAL_SANDBOX_EMAIL` / `PAYPAL_SANDBOX_PASSWORD` - PayPal sandbox buyer account credentials, needed for the Interactive Elicitation sub-step's real redirect to `sandbox.paypal.com`.

Reused existing env vars:

- `KEYCLOAK_DEFAULT_PASSWORD` - already required by the `keycloak` addon; the auth pillar's real-login sub-step uses it with username `user1` against the `agw-dev` realm.

No new credentials needed for Stripe - its "Brokered Elicitation" sub-step stays entirely inline on the wizard's own domain (confirmed via live inspection: no popup, no external navigation), unlike PayPal's genuine external redirect.

## Assertion strategy

Live LLM responses are non-deterministic, so assertions check for _evidence of correct behavior_, not exact text:

- **Routing pillar**: assert a response renders and identifies the correct provider/model, not what it says.
- **Guardrails pillar**: deterministic (regex-matched on fixed input patterns, not LLM output), so these get exact assertions - "Mention an SSN" must show a block message, "Ask for a credit card number" must show a masked response.
- **Agents pillar**: assert the final answer contains real backing-tool data (an actual stock price or FX rate figure), proving the tool call round-tripped, not asserting exact wording.
- **Auth pillar's RBAC/delegation sub-steps**: assert the _before_ state still succeeds (policy not yet applied, matching the wizard's own "try it first" framing) and the _after_ state is denied/blocked once "Apply" is clicked - this is a state transition, not a one-shot check.

## Prerequisite fix (already completed)

While grounding this design against a real deployment, found and fixed a genuine bug in `addons/keycloak/index.js`: `createUsers()` had its own duplicate user-creation path (`createOrUpdateUser`) that hardcoded a literal password on first creation and never touched credentials on update - meaning a redeployed cluster's demo users' passwords permanently diverged from `KEYCLOAK_DEFAULT_PASSWORD` after the first deploy. Fixed by delegating to the already-correct `createOrUpdateUserWithPassword`, which resets the password on every apply. Verified live on zeus: a fresh redeploy now gets a working login immediately, no manual Admin API intervention needed. (Commit `15f56f2` on this branch, already pushed.)

## Out of scope

- CI integration (explicitly not wanted for this pass).
- A new `agw` CLI subcommand to wrap the test invocation (kept as a plain `bunx playwright test` ad-hoc tool).
- Exact button/text selectors for every one of the ~21 sub-steps - these get nailed down per-pillar during implementation by exploring the live page directly, the same way this design was grounded.
