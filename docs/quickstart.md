# Quickstart

Get Jarvis Agents running locally in under 5 minutes.

## Requirements

- **Docker** 24+ with Docker Compose v2
- **Node** 20+ (for local dev against the Strapi API)
- ~2 GB free disk (Postgres + Qdrant + node_modules)

## Install

```bash
git clone https://github.com/junixlabs/jarvis-agents.git
cd jarvis-agents
cp .env.example .env
```

## Configure

Edit `.env`. The minimum required values:

```bash
# Generate with: openssl rand -base64 32
APP_KEYS=<random-1>,<random-2>
API_TOKEN_SALT=<random>
ADMIN_JWT_SECRET=<random>
TRANSFER_TOKEN_SALT=<random>
JWT_SECRET=<random>
ENCRYPTION_KEY=<random>
POSTGRES_PASSWORD=<choose-one>
```

Optional (for AI features):

```bash
LITELLM_API_URL=https://your-llm-proxy/v1
LITELLM_API_KEY=<your-key>
LITELLM_MODEL=claude-sonnet-4-6
```

Without AI keys, core issue tracking works. Agent features degrade gracefully.

## Run

```bash
docker compose up -d
```

Wait ~30 seconds for services to become healthy.

Services:

- **Strapi admin** — <http://localhost:1337/admin> (create admin user on first visit)
- **Web UI** — <http://localhost:3000>
- **Qdrant dashboard** — <http://localhost:6333/dashboard>

## First steps

1. **Create admin user** at <http://localhost:1337/admin> — this is the Strapi admin, separate from regular users.

2. **Generate an API token**: Admin → Settings → API Tokens → Create new API Token → Full access. Save the token.

3. **Create a project** via the web UI (<http://localhost:3000>).

4. **Create your first issue** — use the web UI or:

   ```bash
   export STRAPI_TOKEN=<your-token>
   curl -X POST http://localhost:1337/api/issues \
     -H "Authorization: Bearer $STRAPI_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"data":{"title":"Test issue","project":"<project-id>","status":"open"}}'
   ```

5. **(Optional) Install the desktop app** — see `forge/dev/README.md` for building Tauri locally.

## What's next

- Learn the issue pipeline: [architecture.md → Issue lifecycle](architecture.md)
- Explore the REST API: <http://localhost:1337/documentation> (Strapi auto-docs)
- Set up the MCP server for Claude CLI integration: see `forge/strapi/src/api/chat/`

## Troubleshooting

### `docker compose up` hangs on "waiting for postgres"

Run `docker compose logs postgres`. Common fixes:

- Wrong `POSTGRES_PASSWORD` — reset by `docker compose down -v` + fresh start.
- Port conflict — something else using 5432? Change the port mapping in `docker-compose.yml`.

### Strapi admin shows "Cannot find module"

Run `docker compose exec strapi npm install` then restart: `docker compose restart strapi`.

### Web UI shows connection error to API

Check `NEXT_PUBLIC_API_URL` in `.env`. Default is `http://localhost:1337/api`.

### "Waiting for model" forever in agent chat

You need `LITELLM_API_URL` + `LITELLM_API_KEY` configured. Or use Claude CLI integration via the desktop app.

---

Stuck? Open a [Discussion](https://github.com/junixlabs/jarvis-agents/discussions) — we reply within 72h during alpha.
