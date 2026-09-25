# Agentgateway Field Kit

[![CI](https://img.shields.io/github/actions/workflow/status/day0ops/agentgateway-field-kit/ci.yml?branch=main&label=CI)](https://github.com/day0ops/agentgateway-field-kit/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/day0ops/agentgateway-field-kit)](LICENSE)

Provision, install, demo, and test [agentgateway](https://agentgateway.dev) - Solo.io's commercial enterprise-agentgateway (default) or the open-source agentgateway.dev distribution (opt-in). A Node.js/Bun CLI for cloud infrastructure provisioning and agentgateway installation on Kubernetes clusters, with a library of demo use cases covering routing, security, rate-limiting, MCP, guardrails, streaming, and more.

It drives infrastructure locally (via [lok8s](https://github.com/day0ops/lok8s)) or across AWS, GCP, and Azure through the same set of commands, then layers agentgateway features and demo use cases on top through a small YAML-based config system. Everything here (provisioning, installation, use case deployment) is scriptable, so a full environment can go from nothing to a working demo in one command.

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

## Install

```bash
bun install
```

To use the `agw` command directly instead of `bun run src/cli.js`, link it globally:

```bash
bun link
```

Then verify all required tools are installed:

```bash
agw check-deps
```

## Quick Start

The fastest path from nothing to a running demo: install a local [lok8s](https://github.com/day0ops/lok8s) cluster, agentgateway, and addons in one shot.

```bash
export ENTERPRISE_AGENTGATEWAY_LICENSE=your-enterprise-agentgateway-license-key

# Install local cluster + gateway + addons (interactive profile selection)
agw base install-local
# or
make install-interactive
```

Prefer a cloud cluster or already have one? See [Step-by-Step Workflow](#step-by-step-workflow) below.

## Configuration

Three-layer config system, plus a use case library:

```
config/
├── infra/          # Where clusters run - provider, region       (Kind: InfraProfile)
├── profiles/        # What gets installed - version, addons       (Kind: Profile)
├── environments/     # DNS, TLS, domain settings per environment   (Kind: Environment)
└── usecases/
    ├── enterprise/   # Enterprise-edition demo scenarios
    └── opensource/   # Opensource-edition demo scenarios
```

Profiles reference an infra profile via `spec.infra` and an environment via `spec.environment`. See [docs/reference.md](docs/reference.md) for the full list of built-in infra and installation profiles.

## Step-by-Step Workflow

### 1. Provision base infrastructure

Pick one path. If you already have a Kubernetes cluster and `kubectl` is pointed at it, skip to step 2.

```bash
# Option A — local cluster (lok8s)
agw base infra local install

# Option B — cloud cluster (Terraform); see docs/reference.md for the full provider/profile matrix
agw base infra cloud provision -p eks-single-cluster
source $(agw base infra cloud env -p eks-single-cluster)
```

### 2. Install agentgateway

```bash
export ENTERPRISE_AGENTGATEWAY_LICENSE=your-enterprise-agentgateway-license-key

agw base install
```

Pick your [installation profile](docs/reference.md#installation-profiles) and follow the prompts. For EKS, use the `eks-enterprise-agentgateway-complete` profile - it binds to the `eks-single-cluster` infra profile and `aws-dev` environment automatically.

### 3. Install use cases

```bash
agw usecase deploy
```

Pick your preferred use case and follow the prompts. For example, a use case to demo OpenAI provider routing can be deployed:

![](./images/demo-use-case.png)

### 4. Clean up

```bash
agw usecase clean --current --no-prompt && agw base clean -a
agw base infra local destroy        # or: agw base infra cloud destroy -p <profile>
```

## Editions

`agw` supports two editions of agentgateway, selected per-profile via `spec.edition`:

- **`enterprise`** (default) - Solo.io's commercial `enterprise-agentgateway` chart. Requires `ENTERPRISE_AGENTGATEWAY_LICENSE`.
- **`opensource`** - the [agentgateway.dev](https://agentgateway.dev) open-source distribution. No license needed - use the `eks-opensource-agentgateway` profile.

Use cases live under `config/usecases/enterprise/` or `config/usecases/opensource/`. An unprefixed `--name` (e.g. `mcp/mcp-auth`) resolves to the enterprise use case when one exists with that category/name; add an explicit `opensource/` prefix to pick the opensource one instead. See [docs/reference.md](docs/reference.md#editions) for details.

## More

See [docs/reference.md](docs/reference.md) for the full CLI reference, Makefile targets, built-in infra/installation profiles, environment variables, project structure, runbook generation, and troubleshooting tips.
