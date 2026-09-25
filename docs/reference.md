# Reference

Full reference for the `agw` CLI, Makefile targets, built-in profiles, environment variables, project structure, runbook generation, and editions. See the [README](../README.md) for prerequisites, installation, and the quick start.

## Supported Infrastructure

Infra profiles live in `config/infra/` and describe **where** clusters run. Installation profiles in `config/profiles/` describe **what** gets installed on those clusters. Environment files in `config/environments/` supply DNS, TLS, and domain settings.

### Deployment paths

| Path             | Command                          | Best for                                                    |
| ---------------- | -------------------------------- | ----------------------------------------------------------- |
| Local            | `agw base infra local install`   | Laptop demos with [lok8s](https://github.com/day0ops/lok8s) |
| Cloud            | `agw base infra cloud provision` | Managed EKS / GKE / AKS via Terraform                       |
| Existing cluster | _(skip infra provisioning)_      | Any cluster you already operate                             |

### Cloud providers

The `spec.provider` field in an infra profile selects the Terraform backend:

| Provider       | Cloud           | Notes                                                   |
| -------------- | --------------- | ------------------------------------------------------- |
| `eks`          | AWS EKS         | Route53 DNS supported via environment config            |
| `eks-ipv6`     | AWS EKS         | IPv6 dual-stack, Transit Gateway mesh, optional bastion |
| `gke`          | Google GKE      |                                                         |
| `aks`          | Azure AKS       | Service principal required                              |
| `multicluster` | AKS + EKS + GKE | Mixed-cloud; each cluster declares its own `cloud`      |

See the [terraform-cloud-provisioner environments](../cloud-provisioner/terraform-cloud-provisioner/environments/README.md) for the full matrix of single-, dual-, and tri-cloud Terraform roots.

### Infra profiles

| Profile              | Provider | Environment | Description                                                     |
| -------------------- | -------- | ----------- | --------------------------------------------------------------- |
| `eks-single-cluster` | `eks`    | `aws-dev`   | Single EKS management cluster (2× `t3.xlarge` nodes by default) |

List profiles at any time with `agw base infra cloud list`. Add new profiles by creating YAML files in `config/infra/` (see `config/infra/eks-single-cluster.yaml` for the schema).

### Environments

| Environment | Used by                                                      | Purpose                                    |
| ----------- | ------------------------------------------------------------ | ------------------------------------------ |
| `local`     | Local / lok8s profiles                                       | In-cluster DNS names, self-signed TLS      |
| `aws-dev`   | `eks-single-cluster`, `eks-enterprise-agentgateway-complete` | AWS region, Route53 DNS, Let's Encrypt TLS |

Copy and edit environment files under `config/environments/` to match your AWS account, hosted zone, and domain layout before provisioning cloud infra.

## Installation Profiles

| Profile                                    | Description                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `agentgateway-standard`                    | Standard installation                                                                                                       |
| `agentgateway-with-observability`          | Full observability stack (Solo UI, Prometheus, Grafana, Loki, Tempo)                                                        |
| `agentgateway-with-solo-ui`                | Observability with Solo UI stack                                                                                            |
| `agentgateway-with-keycloak`               | Includes Keycloak integration with the full observability stack                                                             |
| `agentgateway-with-opa`                    | OPA (Open Policy Agent) authorization server for Rego-based model access control demos                                      |
| `agentgateway-with-openfga`                | OpenFGA (ReBAC) authorization server for fine-grained model access control demos                                            |
| `eks-enterprise-agentgateway-complete`     | Complete enterprise demo for EKS: Keycloak, ReBAC (OpenFGA), Solo UI, full observability (gp3, worker nodes, LoadBalancers) |
| `eks-enterprise-agentgateway-lts-complete` | Complete enterprise agentgateway LTS demo on EKS: Keycloak integration                                                      |
| `eks-enterprise-agentgateway-lts-minimal`  | Minimal enterprise agentgateway LTS demo on EKS: Keycloak integration                                                       |
| `eks-enterprise-agentgateway-minimal`      | Minimal enterprise agentgateway (bleeding edge version) demo on EKS: Keycloak integration                                   |
| `eks-opensource-agentgateway`              | Open-source agentgateway.dev with Keycloak, on EKS (no license required)                                                    |
| `agentgateway-custom-config`               | Custom configuration                                                                                                        |
| `agentgateway-custom-version`              | Custom version, OCI registry, and controller extraEnv                                                                       |

List profiles at any time with `agw profile list`.

### Cloud credentials

Configure credentials for the provider(s) in your infra profile before running `agw base infra cloud provision`:

| Provider          | Required                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `eks`, `eks-ipv6` | `AWS_PROFILE` (or standard AWS env vars / IAM role)                                           |
| `gke`             | `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`                                               |
| `aks`             | `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_OBJECT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID` |

You also need **Terraform** installed for cloud provisioning (`agw check-deps` does not verify it).

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

## Environment Variables

| Variable                                                                                      | Required                                     | Description                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ENTERPRISE_AGENTGATEWAY_LICENSE`                                                             | Yes (enterprise edition installs)            | Solo.io enterprise agentgateway license key                                           |
| `OPENAI_API_KEY`                                                                              | No (OpenAI provider use cases)               | OpenAI API key                                                                        |
| `ANTHROPIC_API_KEY`                                                                           | No (Anthropic provider use cases)            | Anthropic API key (direct, not via Vertex)                                            |
| `GEMINI_API_KEY`                                                                              | No (Gemini provider use cases)               | Gemini API key (direct, not via Vertex)                                               |
| `AZURE_OPENAI_API_KEY`                                                                        | No (Azure OpenAI provider use cases)         | Azure OpenAI API key                                                                  |
| `AZURE_OPENAI_ENDPOINT`                                                                       | No, optional                                 | Azure OpenAI resource endpoint override                                               |
| `AWS_ACCESS_KEY_ID`                                                                           | No (Bedrock `authMode: credentials`)         | AWS access key                                                                        |
| `AWS_SECRET_ACCESS_KEY`                                                                       | No (Bedrock `authMode: credentials`)         | AWS secret key                                                                        |
| `AWS_BEDROCK_API_KEY`                                                                         | No (Bedrock default auth mode)               | Bedrock API key, used unless `authMode: credentials`                                  |
| `GOOGLE_APPLICATION_CREDENTIALS`                                                              | No (Vertex AI / GKE)                         | A bearer token, not a key file path                                                   |
| `GCP_PROJECT`                                                                                 | No (Vertex AI / GKE)                         | GCP project ID                                                                        |
| `GCP_LOCATION`                                                                                | No (Vertex AI / GKE)                         | GCP region/location                                                                   |
| `ENTRA_ISSUER_CLIENT_SECRET`                                                                  | No                                           | `jwt-corporate-proxy-entra` and `obo-entra-token-exchange` usecases' live-token tests |
| `OKTA_ISSUER_CLIENT_ID`                                                                       | No                                           | `eager-auth-okta` usecase's live-login test (public/PKCE client, no secret)           |
| `OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET`                                                          | Yes, to deploy `oauth-token-exchange` at all | Not just its live-exchange test                                                       |
| `GITHUB_ISSUER_CLIENT_ID`                                                                     | No                                           | `elicitation-oauth-flow` usecase's GitHub OAuth App (live consent flow)               |
| `GITHUB_ISSUER_CLIENT_SECRET`                                                                 | No                                           | Paired with `GITHUB_ISSUER_CLIENT_ID`                                                 |
| `OPIK_API_KEY`                                                                                | Yes, to deploy `guardrail-webhook` at all    | Not just its live-eval test                                                           |
| `KEYCLOAK_ADMIN_USERNAME`                                                                     | Yes (keycloak addon)                         | No default                                                                            |
| `KEYCLOAK_ADMIN_PASSWORD`                                                                     | Yes (keycloak addon)                         | No default                                                                            |
| `KEYCLOAK_POSTGRES_USER`                                                                      | Yes (keycloak addon)                         | No default                                                                            |
| `KEYCLOAK_POSTGRES_PASSWORD`                                                                  | Yes (keycloak addon)                         | No default                                                                            |
| `SOLO_UI_DEFAULT_PASSWORD`                                                                    | Yes, when `soloUIClients.enabled`            | No default                                                                            |
| `GRAFANA_REALM_ADMIN_USERNAME`                                                                | No (default: `grafana-admin`)                | Only used when a `grafana` realm is configured                                        |
| `GRAFANA_REALM_ADMIN_PASSWORD`                                                                | Yes, when a `grafana` realm is configured    | No default                                                                            |
| `GRAFANA_ADMIN_USERNAME`                                                                      | Yes (telemetry addon)                        | No default                                                                            |
| `GRAFANA_ADMIN_PASSWORD`                                                                      | Yes (telemetry addon)                        | No default                                                                            |
| `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_OBJECT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID` | Yes (AKS)                                    | Azure service principal credentials                                                   |

Vertex AI access tokens expire in ~1 hour - regenerate before each deploy.

## Project Structure

```
.
├── src/
│   ├── cli.js                  # CLI entry point
│   └── lib/                    # Core libraries (installer, infra-manager, feature.js, usecase.js, runbook.js, ...)
├── features/                   # One capability per directory (routing, auth, MCP, guardrails, quota, ...)
├── addons/                     # Infrastructure components installed alongside agentgateway
│   ├── agentgateway-extensions/
│   ├── cert-manager/
│   ├── external-dns/
│   ├── gateway-mtls/
│   ├── keycloak/
│   ├── opa/
│   ├── openfga/
│   ├── opik/
│   ├── solo-ui/
│   └── telemetry/
├── config/
│   ├── infra/                  # InfraProfile YAMLs - where clusters run
│   ├── profiles/                # Profile YAMLs - what gets installed
│   ├── environments/             # Environment YAMLs - DNS/TLS per environment
│   └── usecases/
│       ├── enterprise/           # Enterprise-edition demo scenarios
│       └── opensource/           # Opensource-edition demo scenarios
├── agw-tester/                 # Standalone app for exercising agentgateway + Keycloak interactively (not part of the root workspace)
└── cloud-provisioner/           # Terraform provisioner (git submodule)
```

## CLI Reference

Invoke via `bun run src/cli.js` (or `agw` once linked). Commands follow the `agw <group> <subcommand>` pattern.

### Utilities

```bash
agw version [-s|--short]   # Display banner, version, and description
agw check-deps             # Check if required dependencies are installed
```

### Base — install, clean

```bash
agw base install [-p|--profile <name>] [--infra <name>] [--no-prompt] [--skip-addons]
#   -p, --profile   Installation profile (from config/profiles/)
#   --infra         Infra profile name (sets KUBECONFIG from provisioned state)
#   --skip-addons   Skip addon installation

agw base install-local [-p|--profile <name>] [--infra <name>] [--no-prompt]
#   Install everything: local cluster + gateway + addons

agw base clean [-a|--addons]
#   -a, --addons   Also remove profile-based addons and their namespaces

agw base clean-addons
#   Clean up all profile-based addons (works against any cluster type, with a confirmation prompt)
```

### Base infra local — manage the lok8s cluster

```bash
agw base infra local install    # Install local Kubernetes cluster (lok8s)
agw base infra local destroy    # Remove local Kubernetes cluster
agw base infra local start      # Start local cluster
agw base infra local stop       # Stop local cluster
agw base infra local status     # Show local cluster and gateway status
```

### Base infra cloud — manage cloud infrastructure (EKS, GKE, AKS)

```bash
agw base infra cloud list                              # List available cloud infra profiles
agw base infra cloud provision [-p|--profile <name>] [-y|--yes]
agw base infra cloud destroy   [-p|--profile <name>] [-y|--yes]
agw base infra cloud status    [-p|--profile <name>]
agw base infra cloud env       [-p|--profile <name>] [--print]
#   --print   Print env.sh contents to stdout instead of the path
```

### Use cases

```bash
agw usecase list
agw usecase deploy  [-n|--name <name>] [-y|--yes] [--no-diagrams] [--no-test]
#   -y, --yes        Non-interactive: skip step-by-step prompts and run all steps automatically
#   --no-diagrams    Hide ASCII flow diagrams during stepped deploy
#   --no-test        Skip running use case tests after deploy
agw usecase dryrun  [-n|--name <name>] [-o|--output <file>] [--no-prompt]
#   -o, --output     Write generated YAML to a file instead of stdout
agw usecase test    [-n|--name <name>] [-c|--cleanup] [--no-prompt]
#   -c, --cleanup    Run cleanup after tests complete (undeploys features)
agw usecase clean   [-n|--name <name>] [-c|--current] [--no-prompt]
#   -c, --current    Use currently deployed use case (auto-detect from cluster)
agw usecase generate-diagrams   # Generate spec.diagram (Mermaid) for all use case YAML files
```

### Profiles & features

```bash
agw profile list             # List available installation profiles
agw feature list              # List available features
```

### Runbook generation

```bash
agw runbook generate [-o|--output <file>] [-t|--title <title>]
#   -o, --output   Output file path (default: ./runbook.md)
#   -t, --title    Runbook title (skips title prompt)
```

Generates a self-contained Markdown runbook from this repo's profiles, addons, providers, and use cases. The interactive prompt configures:

- **Title** — runbook document heading
- **Addons** — optional components to install (telemetry, cert-manager, keycloak, solo-ui, opa, openfga, opik, ...)
- **Providers** — LLM backends to demo (openai, bedrock, vertex, etc.)
- **Labs** — use-case or feature labs to include after the providers lab
- **Profile** — pin component versions and configuration (optional)
- **Environment** — deployment environment overrides (optional)

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

The runbook generation code is portable. Copy `src/lib/runbook.js`, `src/lib/runbook-adapters/`, and the per-addon `addons/<name>/runbook.js` sidecars into any repo that follows the same directory layout:

```
config/profiles/    — YAML profile files
config/environments/ — YAML environment files
config/usecases/enterprise/ or opensource/ — YAML use-case definitions
addons/<name>/runbook.js  — addon sidecar (envVarsFor, envExportsFor, generate)
features/index.js   — optional feature registry
```

`RunbookBuilder` defaults `projectRoot` to `process.cwd()`, so no configuration change is needed when running from the target repo's root.

## Makefile Targets

`make <target>` wraps most `agw` commands for convenience. Run `make help` for the full list.

### Setup

| Command                                       | Description                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `agw base install`                            | Install agentgateway                                                             |
| `make install-local`                          | Install everything (`--profile minimal --no-prompt`)                             |
| `make install-interactive`                    | Install everything (interactive profile selection)                               |
| `make install-infra`                          | Install local Kubernetes cluster using [lok8s](https://github.com/day0ops/lok8s) |
| `make start` / `make stop` / `make status`    | Start / stop / show status of the lok8s cluster                                  |
| `agw base infra cloud list`                   | List cloud infra profiles                                                        |
| `agw base infra cloud provision -p <profile>` | Provision cloud infrastructure (EKS, GKE, AKS)                                   |
| `agw base infra cloud status -p <profile>`    | Show cloud infra provisioning status                                             |
| `agw base infra cloud env -p <profile>`       | Print path to sourced env.sh (kubeconfig, domains)                               |
| `agw base infra cloud destroy -p <profile>`   | Destroy provisioned cloud infrastructure                                         |

> `make install-local` runs `agw base install-local --profile minimal --no-prompt` - note there is currently no profile literally named `minimal` under `config/profiles/`; pass an explicit `-p|--profile` (e.g. `agentgateway-standard`) or use `make install-interactive` instead.

### Use cases

| Command                              | Description                              |
| ------------------------------------ | ---------------------------------------- |
| `make list-usecases`                 | List available use cases                 |
| `make deploy-usecase [USECASE=name]` | Deploy a use case (interactive if unset) |
| `make dryrun-usecase [USECASE=name]` | Show generated YAML without applying     |
| `make test-usecase [USECASE=name]`   | Run tests for a use case                 |

### Profiles & features

| Command              | Description                          |
| -------------------- | ------------------------------------ |
| `make list-profiles` | List available installation profiles |
| `make list-features` | List available features              |

### Development

| Command       | Description                    |
| ------------- | ------------------------------ |
| `make test`   | Run tests                      |
| `make lint`   | Lint code (`src/**/*.js` only) |
| `make format` | Format code                    |

### Cleanup

| Command                                     | Description                                                |
| ------------------------------------------- | ---------------------------------------------------------- |
| `make clean`                                | Clean up usecases, gateway, and addons (preserves cluster) |
| `make clean-usecases`                       | Clean up deployed use cases                                |
| `make clean-addons`                         | Clean up all profile-based addons                          |
| `make clean-local-infra`                    | Remove lok8s cluster                                       |
| `agw base infra cloud destroy -p <profile>` | Destroy provisioned cloud infrastructure                   |

### Extras

Extras image build and deploy targets are available via `make` only, and build from an `extras/<name>/` directory per component (e.g. `extras/stock-server-mcp/`):

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

> These targets `$(MAKE) -C extras/<name>` into a sibling `extras/` directory that is not present (and has no history) in this checkout. Confirm whether it's expected to exist locally before relying on the Extras targets.

## Troubleshooting

**AWS credentials error during provision**

```bash
# Re-authenticate SSO
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile>
```

**Check all dependencies**

```bash
agw check-deps
```

**View infra state**

```bash
agw base infra cloud status -p <profile>
```

**Vertex AI 401s after ~1 hour**

`GOOGLE_APPLICATION_CREDENTIALS` here is a bearer token, not a key file path, and Vertex AI tokens expire in ~1 hour. Regenerate and re-export before each deploy.
