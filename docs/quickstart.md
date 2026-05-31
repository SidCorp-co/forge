# Quickstart

Get Forge running end-to-end — server + one paired device + first job — in about 10 minutes.

## Requirements

- **Docker** 24+ with Docker Compose v2
- **Node** 20+ (for local dev against the `packages/core` API)
- **Claude Code CLI** installed on at least one machine (`claude`) with a working Claude Pro or Max subscription
- ~1.5 GB free disk for the server (Postgres + `packages/core` + node_modules)

## 1. Run the server

```bash
git clone https://github.com/SidCorp-co/forge.git
cd forge
cp .env.example .env
```

### Configure `.env`

Minimum required values (see `.env.example` for the full list):

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
- DB inspector (dev only): `pnpm --filter @forge/core db:studio` → opens Drizzle Studio

## 2. Create your first user and project

1. Open <http://localhost:3000> — register a user for the web dashboard.
2. **Verify your email.** Forge requires email verification before you can create your first project. Check the verification email; click the link.
3. Create a project. Note its slug — you'll use it when pairing a device.

> Admin operations (user list, device list, audit log) are exposed at `/admin` in the web app once Phase 2.6 ships. Until then, use Drizzle Studio + REST.

## 3. Pair a device

A device is any machine that will run `claude` for your projects. Most teams start with their development laptop.

### Option A: Desktop GUI (Tauri)

1. Download the desktop app for your OS from [GitHub Releases](https://github.com/SidCorp-co/forge/releases).
2. Install and open it.
3. Point it at your server: `http://localhost:8080` (or your deployed URL).
4. In the web dashboard: **Account → Devices → Add device** → copy the pairing code.
5. In the desktop app: **Settings → Pair** → paste the code.

### Option B: CLI daemon (`forged`)

For CI runners, headless dev boxes, or if you prefer the terminal:

```bash
# Install forged (example — actual install path TBD)

# Pair
forged pair F9-3K7T-92XA
```

The agent stores its token in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) and starts its WebSocket connection. Within seconds your device appears as **online** in the web dashboard.

## 4. Bind the project to the device

1. In the dashboard: **Project → Settings → Runtime** → pick the device you just paired.
2. The UI asks for the local path to the project's git repo on that device. If the repo doesn't exist there yet, the agent can `git clone` for you.
3. Confirm. The device is now the project's **active** runner.

One device is active per project at any time. You can pool multiple devices (Switch Device to drain and hand over when needed).

## 5. Run your first job

Create an issue in the web UI or send a test webhook:

```bash
curl -X POST http://localhost:3000/api/webhooks/in/<project-slug> \
  -H "Content-Type: application/json" \
  -d '{"title":"Test issue","description":"Verify the pipeline works"}'
```

The issue appears in the Kanban. Click **Run triage** — a `forge-triage` job is queued. Within seconds, the device picks it up, spawns `claude` locally with the triage skill, and streams the output to your dashboard.

Watch the session in real time. When triage completes, the issue advances to `confirmed`. Continue through the pipeline (plan → code → review → release) with each stage either auto-running or waiting for your click, depending on your project's configuration.

## What's next

- Learn the full pipeline: [architecture/system-overview.md](architecture/system-overview.md) and [modules/issues-pipeline/status-pipeline.md](modules/issues-pipeline/status-pipeline.md)
- Author a custom skill for a domain-specific pipeline step (how-to coming soon)
- Integrate external sources via webhooks (GitHub events, Sentry alerts, custom)

## Troubleshooting

### `docker compose up` hangs on "waiting for postgres"

`docker compose logs postgres`. Common fixes:

- Wrong `POSTGRES_PASSWORD` — reset via `docker compose down -v` then restart fresh.
- Port conflict — something else using 5432? Change the host-side port in `docker-compose.yml`.

### Device shows as `offline` in the dashboard

- Confirm the agent is running on the machine (`forged status` or check the Tauri app).
- Check the agent log for WebSocket connect errors.
- Server URL mismatch: the agent must point at a URL the server is reachable at (not `localhost` if the agent is on a different machine).

### `forged pair` fails with "pairing code expired"

Codes are valid for 5 minutes. Generate a new one from **Account → Devices → Add device**.

### Device is online but jobs stay `queued`

- Is the project bound to this device? Check **Project → Settings → Runtime**.
- Is another job already `running`? Only one job per device at a time.
- Is `claude` installed on the device and in the PATH? The agent spawns `claude` as a subprocess.

### Email verification loop

Forge sends verification via the configured SMTP provider. For local dev, set `SMTP_DEBUG=true` in `.env` to print verification links to the container logs instead.

---

Stuck? Open a [Discussion](https://github.com/SidCorp-co/forge/discussions) — we reply within 72h during alpha.
