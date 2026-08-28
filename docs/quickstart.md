# Quickstart

Server + one paired device + first job, ~10 minutes.

## Requirements

- **Docker** 24+ with Docker Compose v2
- **Node** 20+ (local dev against `packages/core` API)
- **Claude Code CLI** (`claude`) on at least one machine, with a working Claude Pro or Max subscription
- ~1.5 GB free disk for the server (Postgres + `packages/core` + node_modules)

## 1. Run the server

```bash
git clone https://github.com/SidCorp-co/forge.git
cd forge
cp .env.example .env
```

### Configure `.env`

Minimum required (full list in `.env.example`):

```bash
# Generate strong values: openssl rand -base64 32
JWT_SECRET=<random>
DEVICE_TOKEN_PEPPER=<random>

# Database
POSTGRES_PASSWORD=<choose-one>

# URLs (defaults work for local Docker Compose)
CORS_ORIGINS=http://localhost:3000
APP_BASE_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:8080/api

# SMTP — required by core schema; leave blank for dev (set SMTP_DEBUG=true to log
# verification links to container logs instead of sending email)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

### Start

```bash
docker compose up -d
```

Wait ~30 seconds for services to become healthy.

- Core API + health: <http://localhost:8080/health>
- Web dashboard: <http://localhost:3000>
- DB inspector (dev only): `pnpm --filter @forge/core db:studio` → Drizzle Studio

## 2. Create first user and project

1. Open <http://localhost:3000> — register a user.
2. **Verify your email** (required before creating your first project) — click the link in the email.
3. Create a project. Note its slug (used when pairing a device).

> Operational/admin views live under `/ops` (ops health), `/runners` (device & runner fleet), and `/org` + Settings → Organizations (members & roles); general settings under `/settings`.

## 3. Pair a device

A device is any machine that will run `claude` for your projects (commonly your dev laptop or a headless box). Forge pairs devices with the **`forge-runner`** daemon:

```bash
# Install
curl -fsSL http://localhost:8080/install.sh | sh

# Pair — opens a browser to approve (use --code on a headless host)
forge-runner login
```
