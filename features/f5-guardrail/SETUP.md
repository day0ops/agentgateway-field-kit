# F5 AI Guardrails: initial setup

Quick start before deploying the `f5-guardrail` usecase.

1. Request access from F5 sales - there's no public self-serve signup or trial for F5 AI Guardrails specifically: https://www.f5.com/products/get-f5?ls=meta#contactsales
2. Log into the F5 AI Guardrails console with the credentials F5 provisions, and note the console's base URL - that's your `F5_AISEC_URL`.
3. Under **API tokens**, generate a token and copy it immediately - it's shown only once. That's your `F5_AISEC_TOKEN`.
4. Create or select a project in the console. Its id, friendlyId, or display name is your `CAI_PROJECT`.
5. In the console's **Custom guardrails** page, enable at least one scanner on the project - a fresh project has none enabled, so every scan comes back clean and nothing in the demo will ever block or mask.
6. Export the three env vars:

```bash
export F5_AISEC_URL=<your console's base URL>
export F5_AISEC_TOKEN=<the API token from step 3>
export CAI_PROJECT=<the project id, friendlyId, or name from step 4>
```

Deploying the usecase fails fast if any of these is unset.
