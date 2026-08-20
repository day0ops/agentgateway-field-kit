# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Overview

`agw` is a Bun/Node CLI (entry point `src/cli.js`) for demoing [agentgateway](https://agentgateway.dev) - Solo.io's commercial enterprise-agentgateway (default) or the open-source agentgateway.dev distribution (opt-in). It provisions Kubernetes clusters (local via `lok8s`, cloud via Terraform), installs the gateway via Helm, and deploys demo "use cases" (routing, security, rate-limiting, MCP, guardrails, streaming, etc.).

`agw-tester/` is a separate app for exercising agentgateway + Keycloak interactively - not part of the root workspace.

`cloud-provisioner/terraform-cloud-provisioner` is a git submodule; run `git submodule update --init --recursive` if it's empty.

## Commands

```bash
bun install                     # install deps
bun link                        # create the `agw` command
agw --help                      # explore the CLI
bun test test/**/*.test.js      # run tests
bun run lint                    # lint src/**/*.js only
bun run format                  # prettier --write .
```

`make <target>` wraps most `agw` commands. Run `make help` for the full list.

## Environment variables

```bash
export ENTERPRISE_AGENTGATEWAY_LICENSE=<key>   # required
export OPENAI_API_KEY=                 # OpenAI provider
export ANTHROPIC_API_KEY=              # Anthropic provider
export GEMINI_API_KEY=                 # Gemini provider
export AZURE_OPENAI_API_KEY=           # Azure OpenAI provider
export AWS_ACCESS_KEY_ID=              # Bedrock / EKS
export AWS_SECRET_ACCESS_KEY=
export AWS_BEDROCK_API_KEY=            # Bedrock (default auth mode)
export GOOGLE_APPLICATION_CREDENTIALS=  # Vertex AI / GKE - a bearer token, not a key file path
export GCP_PROJECT=
export GCP_LOCATION=
export ENTRA_ISSUER_CLIENT_SECRET=     # jwt-corporate-proxy-entra and obo-entra-token-exchange usecases' live-token tests
export OKTA_ISSUER_CLIENT_ID=          # eager-auth-okta usecase's live-login test (public/PKCE client, no secret)
export OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET=  # required to deploy oauth-token-exchange at all, not just its live-exchange test
export GITHUB_ISSUER_CLIENT_ID=        # elicitation-oauth-flow usecase's GitHub OAuth App (live consent flow)
export GITHUB_ISSUER_CLIENT_SECRET=
export KEYCLOAK_ADMIN_USERNAME=        # required by the keycloak addon, no default
export KEYCLOAK_ADMIN_PASSWORD=        # required by the keycloak addon, no default
export KEYCLOAK_POSTGRES_USER=         # required by the keycloak addon, no default
export KEYCLOAK_POSTGRES_PASSWORD=     # required by the keycloak addon, no default
export SOLO_UI_DEFAULT_PASSWORD=       # required only when soloUIClients.enabled, no default
export GRAFANA_REALM_ADMIN_USERNAME=   # optional, only used when a 'grafana' realm is configured (default: 'grafana-admin')
export GRAFANA_REALM_ADMIN_PASSWORD=   # required only when a 'grafana' realm is configured, no default
export GRAFANA_ADMIN_USERNAME=         # required by the telemetry addon, no default
export GRAFANA_ADMIN_PASSWORD=         # required by the telemetry addon, no default
```

AKS also needs `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_OBJECT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID`.

Vertex AI access tokens expire in ~1 hour - regenerate before each deploy.

## Architecture

- **`config/infra/`** - where clusters run.
- **`config/profiles/`** - what gets installed on a cluster.
- **`config/environments/`** - DNS/TLS per environment.
- **`config/usecases/<enterprise|opensource>/`** - demo scenarios, deployed via `agw usecase deploy --name <category>/<name>`.

Features live in `features/<name>/index.js` (one capability per directory), addons in `addons/<name>/`. Both extend the `Feature` base class (`deploy()`/`cleanup()`/`validate()`) and register in their `index.js`.

`agw runbook generate` builds a Markdown runbook from profiles/addons/providers/use cases.

### Editions

Two editions: **enterprise** (default, needs `ENTERPRISE_AGENTGATEWAY_LICENSE`) and **opensource** (opt-in via `spec.edition: opensource`). This picks which Helm chart/CRDs get installed and which CRD group features emit.

Most features work on both editions unmodified. Some are enterprise-only because no equivalent OSS CRD exists: ext-auth/token-exchange, quota/budget, and the `entMcp` family (`mcp-enterprise`, `mcp-guardrails`).

Usecase names resolve to the enterprise edition by default; use an `opensource/...` prefix to pick the OSS version when both exist.

### UseCase YAML descriptions

- Never soft-wrap prose in UseCase yaml descriptions by inserting line breaks mid-paragraph. Don't add newlines for no reason, let lines run long and wrap naturally. Otherwise they don't render well in standard out.
- Keep descriptions concise and not deeply technical.

## Gotchas

- `bun run lint` only covers `src/**/*.js` - not `features/`, `addons/`, or `agw-tester/`.
