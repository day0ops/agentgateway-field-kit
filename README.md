# Agentgateway Field Kit

A modular framework for demonstrating [agentgateway](https://agentgateway.dev) features.

![](./images/install.png)

## Prerequisites

Ensure you have the following installed:

- **Node.js** >= 24.14.0
- **[bun](https://bun.sh)** - JavaScript runtime and package manager
- **Docker Desktop** - for building and pushing images
- **kubectl** - Kubernetes CLI
- **helm** - Kubernetes package manager
- **[Terraform](https://www.terraform.io/) or [OpenTofu](https://opentofu.org/)** - for cloud cluster provisioning
- **jq** - JSON processor

Set the following environment variables:

```bash
export ENTERPRISE_AGENTGATEWAY_LICENSE=your-enterprise-agentgateway-license-key
```

Set the following environment variables if your profile uses the `keycloak` or `telemetry` addons - there are no defaults, so deploying either addon without them fails cleanly:

```bash
# keycloak addon
export KEYCLOAK_ADMIN_USERNAME=admin
export KEYCLOAK_ADMIN_PASSWORD=
export KEYCLOAK_POSTGRES_USER=postgres
export KEYCLOAK_POSTGRES_PASSWORD=
# only when the profile's keycloak config sets soloUIClients.enabled
export SOLO_UI_DEFAULT_PASSWORD=

# telemetry addon (Grafana)
export GRAFANA_ADMIN_USERNAME=admin
export GRAFANA_ADMIN_PASSWORD=
```

Set the following environment variables depending on which LLM providers you intend to use:

```bash
# OpenAI
export OPENAI_API_KEY=

# Anthropic (direct, not via Vertex)
export ANTHROPIC_API_KEY=

# Gemini (direct, not via Vertex)
export GEMINI_API_KEY=

# Azure OpenAI
export AZURE_OPENAI_API_KEY=

# AWS Bedrock
export AWS_ACCESS_KEY_ID=              # authMode: credentials
export AWS_SECRET_ACCESS_KEY=          # authMode: credentials
export AWS_BEDROCK_API_KEY=            # default authMode (not 'credentials') - a Bedrock API key

# Google Vertex AI
export GOOGLE_APPLICATION_CREDENTIALS=
export GCP_PROJECT=
export GCP_LOCATION=

# Microsoft Entra ID (jwt-corporate-proxy-entra and obo-entra-token-exchange usecases' live-token tests)
export ENTRA_ISSUER_CLIENT_SECRET=

# Okta issuer (eager-auth-okta usecase's live-login test - public/PKCE client, no secret)
export OKTA_ISSUER_CLIENT_ID=

# OAuth token exchange (required to deploy the oauth-token-exchange usecase at all, not just its live-exchange test)
export OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET=

# GitHub OAuth App (elicitation-oauth-flow usecase's live consent flow)
export GITHUB_ISSUER_CLIENT_ID=
export GITHUB_ISSUER_CLIENT_SECRET=
```

## Installation

### 1. Install Node dependencies

```bash
bun install
bun link
```

This installs dependencies and creates a link for `agw` command.

### 2. Check dependencies

```bash
# Verify all required tools are installed
agw check-deps
```

### 3. Provision base infrastructure

Pick one path below. If you already have a Kubernetes cluster and `kubectl` is pointed at it, skip this step.

#### Option A — Local cluster ([lok8s](https://github.com/day0ops/lok8s))

Install [lok8s](https://github.com/day0ops/lok8s), then create the local cluster:

```bash
agw base infra local install
```

Use `agw base infra local start`, `stop`, and `status` to manage the cluster after install.

#### Option B — Cloud cluster (Terraform)

Provision managed Kubernetes in AWS, GCP, or Azure from an [infra profile](#supported-infrastructure) under `config/infra/`:

```bash
# List available infra profiles
agw base infra cloud list

# Provision (interactive profile selection)
agw base infra cloud provision

# Or provision a specific profile
agw base infra cloud provision -p eks-single-cluster
```

After provisioning, load the generated kubeconfig and environment variables:

```bash
source $(agw base infra cloud env -p eks-single-cluster)
```

Check status or tear down when finished:

```bash
agw base infra cloud status -p eks-single-cluster
agw base infra cloud destroy -p eks-single-cluster
```

Cloud provisioning uses [Terraform modules](cloud-provisioner/terraform-cloud-provisioner/README.md) bundled in this repo. You also need **Terraform** installed and cloud credentials configured for your target provider — see [Supported Infrastructure](#supported-infrastructure) for details.

#### Option C — Bring your own cluster

Point `kubectl` at any existing cluster and continue to step 4. No `agw` infra commands are required.

### 4. Install agentgateway

Run the following command to install agentgateway:

```bash
agw base install
```

Pick your [preferred profile](#supported-profiles) and follow the prompts to install the framework.

For EKS, use the `eks-enterprise-agentgateway-complete` profile — it binds to the `eks-single-cluster` infra profile and `aws-dev` environment automatically. After cloud provisioning, `agw base install` resolves kubeconfig from the provisioned infra state.

### 5. Install use cases

Run the following command to install use cases:

```bash
agw usecase deploy
```

Pick your preferred use case and follow the prompts to install the framework.
For e.g. a use case to demo OpenAI provider routing can be deployed:

![](./images/demo-use-case.png)

## Supported Infrastructure

Infra profiles live in `config/infra/` and describe **where** clusters run. Installation profiles in `config/profiles/` describe **what** gets installed on those clusters. Environment files in `config/environments/` supply DNS, TLS, and domain settings.

### Deployment paths

| Path             | Command                          | Best for                                                    |
| ---------------- | -------------------------------- | ----------------------------------------------------------- |
| Local            | `agw base infra local install`   | Laptop demos with [lok8s](https://github.com/day0ops/lok8s) |
| Cloud            | `agw base infra cloud provision` | Managed EKS / GKE / AKS via Terraform                       |
| Existing cluster | _(skip step 3)_                  | Any cluster you already operate                             |

### Cloud providers

The `spec.provider` field in an infra profile selects the Terraform backend:

| Provider       | Cloud           | Notes                                                   |
| -------------- | --------------- | ------------------------------------------------------- |
| `eks`          | AWS EKS         | Route53 DNS supported via environment config            |
| `eks-ipv6`     | AWS EKS         | IPv6 dual-stack, Transit Gateway mesh, optional bastion |
| `gke`          | Google GKE      |                                                         |
| `aks`          | Azure AKS       | Service principal required                              |
| `multicluster` | AKS + EKS + GKE | Mixed-cloud; each cluster declares its own `cloud`      |

See the [terraform-cloud-provisioner environments](cloud-provisioner/terraform-cloud-provisioner/environments/README.md) for the full matrix of single-, dual-, and tri-cloud Terraform roots.

### Infra profiles

| Profile              | Provider | Environment | Description                                                     |
| -------------------- | -------- | ----------- | --------------------------------------------------------------- |
| `eks-single-cluster` | `eks`    | `aws-dev`   | Single EKS management cluster (2× `t3.xlarge` nodes by default) |

List profiles at any time:

```bash
agw base infra cloud list
```

Add new profiles by creating YAML files in `config/infra/` (see `config/infra/eks-single-cluster.yaml` for the schema).

### Environments

| Environment | Used by                                                      | Purpose                                    |
| ----------- | ------------------------------------------------------------ | ------------------------------------------ |
| `local`     | Local / lok8s profiles                                       | In-cluster DNS names, self-signed TLS      |
| `aws-dev`   | `eks-single-cluster`, `eks-enterprise-agentgateway-complete` | AWS region, Route53 DNS, Let's Encrypt TLS |

Copy and edit environment files under `config/environments/` to match your AWS account, hosted zone, and domain layout before provisioning cloud infra.

### Cloud credentials

Configure credentials for the provider(s) in your infra profile before running `agw base infra cloud provision`:

| Provider          | Required                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `eks`, `eks-ipv6` | `AWS_PROFILE` (or standard AWS env vars / IAM role)                                           |
| `gke`             | `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`                                               |
| `aks`             | `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_OBJECT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID` |

You also need **Terraform** installed for cloud provisioning (`agw check-deps` does not verify it).

## Supported Profiles

| Profile                                | Description                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agentgateway-standard`                | Standard installation                                                                                                       |
| `agentgateway-with-observability`      | Full observability stack (Solo UI, Prometheus, Grafana, Loki, Tempo)                                                        |
| `agentgateway-with-solo-ui`            | Observability with Solo UI stack                                                                                            |
| `agentgateway-with-keycloak`           | Includes Keycloak integration with the full observability stack                                                             |
| `eks-enterprise-agentgateway-complete` | Complete enterprise demo for EKS: Keycloak, ReBAC (OpenFGA), Solo UI, full observability (gp3, worker nodes, LoadBalancers) |
| `eks-opensource-agentgateway`          | Open-source agentgateway.dev with Keycloak, on EKS (no license required)                                                    |
| `agentgateway-custom-config`           | Custom configuration                                                                                                        |
| `agentgateway-custom-version`          | Custom version, OCI registry, and controller extraEnv                                                                       |

## Editions

`agw` supports two editions of agentgateway, selected per-Profile via `spec.edition`:

- **`enterprise`** (default) - Solo.io's commercial `enterprise-agentgateway` chart. Requires `ENTERPRISE_AGENTGATEWAY_LICENSE`. All profiles above except `eks-opensource-agentgateway` install this edition.
- **`opensource`** - the [agentgateway.dev](https://agentgateway.dev) open-source distribution. No license needed. Use the `eks-opensource-agentgateway` profile to install it:

```bash
agw base install --profile eks-opensource-agentgateway
```

Use cases live under `config/usecases/enterprise/` or `config/usecases/opensource/`. An unprefixed `--name` (e.g. `mcp/mcp-auth`) resolves to the enterprise use case if one exists with that category/name; add an explicit prefix to pick the opensource one:

```bash
agw usecase deploy --name opensource/mcp/mcp-auth
```

Every feature declares which edition(s) it supports (`Feature.SUPPORTED_EDITIONS` in `src/lib/feature.js`, default: both). Deploying a use case whose edition isn't supported by one of its features fails immediately, before any Kubernetes calls are made.

## Runbook Generation

Generate a self-contained runbook runbook (Markdown) from this repo's profiles, addons, providers, and use cases.

```bash
agw runbook generate
```

The command runs an interactive prompt to configure:

- **Title** — runbook document heading
- **Addons** — optional components to install (telemetry, cert-manager, keycloak, solo-ui)
- **Providers** — LLM backends to demo (openai, bedrock, vertex, etc.)
- **Labs** — use-case or feature labs to include after the providers lab
- **Profile** — pin component versions and configuration (optional)
- **Environment** — deployment environment overrides (optional)

Output is written to `./runbook.md` by default. Use `-o` to change the path:

```bash
agw runbook generate -o docs/my-runbook.md
```

Pass `-t` to set the title without a prompt:

```bash
agw runbook generate -t "Agentgateway Hands-on Lab"
```

### Runbook Structure

The generated document follows this structure:

| Section                    | Content                                                 |
| -------------------------- | ------------------------------------------------------- |
| `## Environment Variables` | Credential table + consolidated `export` block          |
| `## Prerequisites`         | Required tools (kubectl, helm, jq, etc.)                |
| `## Component Versions`    | Version table sourced from the selected profile         |
| `## Lab 0: Installation`   | agentgateway + Gateway API CRDs + addon installs        |
| `## Lab 1: Providers`      | Provider-specific manifests (one per selected provider) |
| `## Lab N: <use-case>`     | Use-case or feature lab content                         |
| `## Cleanup`               | Teardown commands                                       |

### Portability

The runbook generation code is portable. Copy `src/lib/runbook.js`, `src/lib/runbook-adapters/`, and the per-addon `addons/<name>/runbook.js` sidecars into any repo that follows the same directory layout:

```
config/profiles/    — YAML profile files
config/environments/ — YAML environment files
config/usecases/enterprise/ or opensource/ — YAML use-case definitions
addons/<name>/runbook.js  — addon sidecar (envVarsFor, envExportsFor, generate)
features/index.js   — optional feature registry
```

`RunbookBuilder` defaults `projectRoot` to `process.cwd()`, so no configuration change is needed when running from the target repo's root.

---

## Commands

The `agw` CLI is the primary interface for this project. Run `agw --help` to explore subcommands, or `agw <command> --help` for details on a specific command.

> **Optional:** Equivalent [`make`](Makefile) targets wrap the same `agw` commands for convenience (e.g. `make install` → `agw base install`). Run `make help` to see the full list. Extras image build/deploy targets are currently available only via `make`.

### Setup

| Command                                                | Description                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `agw base install`                                     | Install agentgateway                                                             |
| `agw base install-local --profile minimal --no-prompt` | Install everything (minimal profile)                                             |
| `agw base install-local`                               | Install everything (interactive profile selection)                               |
| `agw base infra local install`                         | Install local Kubernetes cluster using [lok8s](https://github.com/day0ops/lok8s) |
| `agw base infra local start`                           | Start lok8s cluster                                                              |
| `agw base infra local stop`                            | Stop lok8s cluster                                                               |
| `agw base infra local status`                          | Show local cluster and gateway status                                            |
| `agw base infra cloud list`                            | List cloud infra profiles                                                        |
| `agw base infra cloud provision -p <profile>`          | Provision cloud infrastructure (EKS, GKE, AKS)                                   |
| `agw base infra cloud status -p <profile>`             | Show cloud infra provisioning status                                             |
| `agw base infra cloud env -p <profile>`                | Print path to sourced env.sh (kubeconfig, domains)                               |
| `agw base infra cloud destroy -p <profile>`            | Destroy provisioned cloud infrastructure                                         |

### Use Cases

| Command                                                         | Description                                      |
| --------------------------------------------------------------- | ------------------------------------------------ |
| `agw usecase list`                                              | List available use cases                         |
| `agw usecase deploy`                                            | Deploy a use case (interactive)                  |
| `agw usecase deploy --name routing/openai-provider`             | Deploy a specific use case                       |
| `agw usecase dryrun --name routing/openai-provider`             | Show generated YAML without applying             |
| `agw usecase dryrun --name routing/openai-provider -o out.yaml` | Write generated YAML to a file instead of stdout |
| `agw usecase test --name routing/openai-provider`               | Run tests for a use case                         |
| `agw usecase clean --current --no-prompt`                       | Clean up deployed use cases                      |

### Profiles & Features

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `agw profile list` | List available installation profiles |
| `agw feature list` | List available features              |

### Development

| Command          | Description |
| ---------------- | ----------- |
| `bun test`       | Run tests   |
| `bun run lint`   | Lint code   |
| `bun run format` | Format code |

### Cleanup

| Command                                                        | Description                              |
| -------------------------------------------------------------- | ---------------------------------------- |
| `agw usecase clean --current --no-prompt && agw base clean -a` | Clean up use cases, gateway, and addons  |
| `agw usecase clean --current --no-prompt`                      | Clean up deployed use cases              |
| `agw base clean -a`                                            | Clean up profile-based addons            |
| `agw base infra local destroy`                                 | Remove local Kubernetes cluster          |
| `agw base infra cloud destroy -p <profile>`                    | Destroy provisioned cloud infrastructure |

`agw base clean` also accepts `-a` / `--addons` to include addon cleanup in a single command.

### Extras

Extras image build and deploy targets are available via `make` only:

| Command                           | Description                        |
| --------------------------------- | ---------------------------------- |
| `make build-extras`               | Build all extra images             |
| `make push-extras`                | Push all extra images (multi-arch) |
| `make deploy-stock-server-mcp`    | Deploy stock MCP server to K8s     |
| `make deploy-currency-server-mcp` | Deploy currency MCP server to K8s  |
| `make deploy-random-server-mcp`   | Deploy random MCP server to K8s    |
| `make deploy-guardrail-webhook`   | Deploy guardrail webhook to K8s    |
| `make deploy-stock-agent`         | Deploy stock agent to K8s          |
| `make deploy-caller-agent`        | Deploy caller agent to K8s         |
| `make deploy-quota-management`    | Deploy quota management to K8s     |
