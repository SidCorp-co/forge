# Integrations

Two-level model since ISS-398/ISS-429:

| Concept | What it is | Where managed |
|---|---|---|
| **Connection** | The credential (Coolify token, Postman key, Epodsystem `crmk_` key), owned by a user/org | Workspace → **Integrations** (connections directory) |
| **Binding** | Links a connection into one project + environment (`staging`/`prod`) | Project settings → **Integrations** tab |

## Project settings → Integrations (the management surface)

- **Status cards** — one card per binding (a disabled binding never hides an active one). Click a provider card to configure: create, Test, rotate webhook secret, disconnect, delivery log (providers with `hasDeliveryLog`).
- **Agent MCP servers** — exactly what the dispatch resolver will inject into this project's agents (`mcpServers.postman` / `mcpServers.epodsystem`): real URL, env, redacted auth, and a Verify action. Backed by `GET /api/projects/:id/integrations/mcp-preview`, which runs the same builders/filters as the resolver, so it cannot drift.
- **Share an existing connection** — bind a connection you already own to this project without re-entering the credential.

## Workspace → Integrations (connections directory)

Lists every connection you own — including disabled ones (re-enable from here). Per connection: provider, truthful health, "Projects using it" (bindings), enable/disable.

## Card states

| State | Meaning |
|---|---|
| Connected | Last health signal was ok |
| Degraded | Provider reported degraded/pending/unknown, or the circuit breaker is open |
| Error | Last health signal failed |
| Needs re-auth | Credential was rejected — re-enter it |
| Not verified | Active but never health-checked (no signal ≠ degraded) |
| Disabled | Binding/connection exists but is switched off |
| Not connected | Nothing configured |

## How health stays current

- Successful **deploy dispatch** writes `ok` (coolify).
- **Create/bind** runs an immediate probe (time-boxed 5s; result returned in the 201 body).
- **Test** button runs the provider healthcheck on demand.
- An hourly **health sweep** re-probes every active connection not checked in the last 30 min (covers MCP providers, which never dispatch).

## MCP injection rules

- One `mcpServers.<provider>` slot per provider; with multiple active bindings the **oldest binding wins** (deterministic). The MCP panel marks losers `Shadowed`.
- Entry is injected only when the binding AND connection are active and a credential is stored (`Will inject`); otherwise the panel shows `Disabled` / `No credential` / `Not configured`.
- Credentials are attached only at dispatch time (runner `--mcp-config`); they never appear in API responses or the DOM.
