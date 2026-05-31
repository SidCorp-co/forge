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

> Admin ops (user list, device list, audit log) live at `/admin` once Phase 2.6 ships. Until then: Drizzle Studio + REST.

## 3. Pair a device

A device is any machine that will run `claude` for your projects (commonly your dev laptop).

### Option A: Desktop GUI (Tauri)

1. Download the desktop app for your OS from [GitHub Releases](https://github.com/SidCorp-co/forge/releases).
2. Install and open it.
3. Point it at your server: `http://localhost:8080` (or your deployed URL).
4. Web dashboard: **Account → Devices → Add device** → copy the pairing code.
5. Desktop app: **Settings → Pair** → paste the code.

### Option B: CLI daemon (`forged`)

For CI runners, headless dev boxes, or terminal preference:

```bash
# Install forged (example — actual install path TBD)

# Pair
forged pair F9-3K7T-92XA
```

Token stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service); WebSocket connects; device appears **online** within seconds.

## 4. Bind the project to the device

1. Dashboard: **Project → Settings → Runtime** → pick the paired device.
2. Provide the local path to the project's git repo on that device. If absent there, the agent can `git clone` for you.
3. Confirm. The device is now the project's **active** runner.

One device active per project at a time. Pool multiple devices (Switch Device to drain and hand over).

## 5. Run your first job

Create an issue in the web UI or send a test webhook:

```bash
curl -X POST http://localhost:3000/api/webhooks/in/<project-slug> \
  -H "Content-Type: application/json" \
  -d '{"title":"Test issue","description":"Verify the pipeline works"}'
```

Issue appears in the Kanban. Click **Run triage** → a `forge-triage` job queues. Within seconds the device picks it up, spawns `claude` locally with the triage skill, streams output to the dashboard.

On triage complete the issue advances to `confirmed`. Continue through the pipeline (plan → code → review → release) — each stage auto-runs or waits for your click per project config.

## What's next

- Full pipeline: [architecture/system-overview.md](architecture/system-overview.md) and [modules/issues-pipeline/status-pipeline.md](modules/issues-pipeline/status-pipeline.md)
- Author a custom skill for a domain-specific pipeline step (how-to coming soon)
- Integrate external sources via webhooks (GitHub events, Sentry alerts, custom)

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up` hangs on "waiting for postgres" | `docker compose logs postgres`. Wrong `POSTGRES_PASSWORD` → `docker compose down -v` then restart fresh. Port conflict on 5432 → change host-side port in `docker-compose.yml`. |
| Device shows `offline` | Confirm agent running (`forged status` or Tauri app). Check agent log for WebSocket connect errors. Server URL mismatch — agent must point at a reachable URL (not `localhost` if on a different machine). |
| `forged pair` fails "pairing code expired" | Codes valid 5 minutes. Generate a new one from **Account → Devices → Add device**. |
| Device online but jobs stay `queued` | Project bound to this device? (**Project → Settings → Runtime**). Another job already `running`? (one per device). Is `claude` installed and in PATH? (agent spawns it as a subprocess). |
| Email verification loop | Forge sends via configured SMTP. For local dev set `SMTP_DEBUG=true` in `.env` to print verification links to container logs. |

---

Stuck? Open a [Discussion](https://github.com/SidCorp-co/forge/discussions) — we reply within 72h during alpha.
