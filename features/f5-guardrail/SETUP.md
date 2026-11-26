# Setting up F5 AI Guardrails for this demo

Before deploying the `enterprise/guardrail/f5-guardrail` usecase you need three
values: `F5_AISEC_URL`, `F5_AISEC_TOKEN`, and `CAI_PROJECT`. This guide covers getting
them.

## 1. Get access

There is no public self-serve signup or free trial for F5 AI Guardrails (formerly
CalypsoAI - F5 completed the acquisition on 2025-09-26 and the CalypsoAI brand is fully
retired). Contact F5 sales to request access and a tenant:
https://www.f5.com/products/get-f5?ls=meta#contactsales . F5 will provision your account
and give you a console URL (e.g. `https://us1.calypsoai.app` or
`https://us2.calypsoai.app`) and initial login credentials. That console URL is your
`F5_AISEC_URL`.

## 2. Log in and create an API token

Log into the F5 AI Guardrails console (sometimes called the "Moderator" UI) with the
credentials F5 gave you. Under the **API tokens** section, generate a new token and copy
it immediately - it's shown only once. That value is `F5_AISEC_TOKEN`.

A token can be scoped globally or to a single project. A project-scoped token can only
use the scanners enabled on that project. For this demo, either scope the token to the
project from the next step, or use a global token alongside an explicit `CAI_PROJECT`.

## 3. Create or select a project

Create a project in the console for this demo (any name works, e.g.
`agentgateway-demo`). `CAI_PROJECT` accepts that project's id, friendlyId, or display
name - whichever the console shows you.

## 4. Enable scanners on the project

A fresh project has no scanners enabled, so every scan comes back clean and nothing in
the demo will ever block or mask. In the console's **Custom guardrails** page, enable at
least a few scanners, for example:

| Scanner type | Pattern/keyword                             | Direction             | Mode   |
| ------------ | ------------------------------------------- | --------------------- | ------ |
| Keyword      | a banned phrase you'll use in a test prompt | Prompts and responses | Block  |
| Regex        | credit card number pattern                  | Prompts               | Redact |
| Regex        | email address pattern                       | Prompts               | Redact |

Match these to whatever prompts `config/usecases/enterprise/guardrail/f5/f5-guardrail.yaml`'s
tests actually send. Configuring scanners via F5's scanner-management API instead of the
console UI is possible (see Further reading for a worked example) but is out of scope
for this guide and for the `agw` CLI, which only deploys the adapter and wires
credentials to an already-configured project - it doesn't provision F5-side policy.

## 5. Set the env vars

```bash
export F5_AISEC_URL=<your console's base URL, e.g. https://us1.calypsoai.app>
export F5_AISEC_TOKEN=<the API token from step 2>
export CAI_PROJECT=<the project id, friendlyId, or name from step 3>
```

Deploying the usecase fails fast if any of these is unset.

## Troubleshooting

- **"project not found"**: `CAI_PROJECT` must be a project id, friendlyId, or name your
  tenant actually recognizes - check the console's project list for the exact value.
- **Adapter returns a 503 / reject mentioning "scan failed"**: the adapter couldn't reach
  F5's Scan API. Check `F5_AISEC_URL`, `F5_AISEC_TOKEN`, `CAI_PROJECT`, and the adapter's
  pod logs: `kubectl logs -n agentgateway-system deploy/f5-guardrail-webhook`.
- **A prompt that should block or mask passes through clean**: confirm the matching
  scanner (step 4) is enabled on the exact project `CAI_PROJECT` points at, not a
  different one in the same tenant.

## Further reading

- F5 AI Guardrails sales contact: https://www.f5.com/products/get-f5?ls=meta#contactsales
- F5 AI Guardrails API docs (requires an F5 account): https://docs.aisecurity.f5.com
- A public reference integration showing this same out-of-band webhook pattern end to
  end, including a scanner-provisioning script:
  https://github.com/sebbycorp/agentgateway-demos/tree/main/202-agw-f5-ai
