# Live preview: see a change before it ships

**Removed when:** ISS-491 closes, that is when the three build lanes below have landed. What holds
after that is the code, the contracts and the approved Issue to release and Chat turn designs.

Requirement REQ-39 r1 "See a change live before it ships", BC-1..13. Delivery issue ISS-491. The
shared contracts are landed: `packages/contracts/src/preview.ts`, `preview-tunnel.ts`,
`fast-lane.ts` and `packages/contracts/fixtures/preview-tunnel-frames.json`. Three build lanes
follow: preview-tunnel, preview-web and fast-lane. The split is at the end of this file.

## Pattern

Port forwarding as Coder and Gitpod do it. Core serves the preview on a separate wildcard site, and
the box only dials its own loopback.

- **Coder's app URL.** `coder/coder` `coderd/workspaceapps/appurl/appurl.go:ApplicationURL` puts the
  port, agent, workspace and user in one label on a wildcard apps domain.
- **Why a separate site.** The `DisablePathApps` comment in `coderd/workspaceapps/proxy.go` says a
  path-based app shares the dashboard's cookies and can script against it. A subdomain app cannot.
- **The ticket.** Coder's dashboard passes the app host an encrypted key that lives one minute
  (`coderd/workspaceapps/token.go:EncryptedAPIKeyPayload.Fill`). The app host turns it into its own
  cookie and redirects, which strips the key from the URL.
- **Gitpod.** Gitpod follows the same shape: `<port>-<workspace>.ws.gitpod.io` with an owner-token
  cookie. This was not verified in source.
- **Why not a path proxy.** code-server offers both (`coder/code-server`
  `src/node/routes/pathProxy.ts`, `domainProxy.ts`). Its `/absproxy` exists because dev servers emit
  absolute asset paths (`/_next/…`, `/@vite/client`). A host-per-preview forwards `/` untouched, so
  no app needs a base path.

The tunnel is our own multiplexing, shaped like yamux. **Buy before build** was judged as follows.
On the runner, Rust `yamux` 0.14 (`libp2p/rust-yamux`, Apache-2.0 OR MIT) covers the mux. On core,
`@libp2p/yamux` and `@chainsafe/libp2p-yamux` are built around libp2p's connection interfaces, and
`yamux-js` is a small, thinly maintained package. Neither side reaches 80% without an adapter and an
interop test that nobody has run.

The part that is bought is HTTP. Core proxies each browser request with Node's own `http.request`.
Its `createConnection` returns a tunnel stream, so Node handles headers, chunking, keep-alive and the
`101 Switching Protocols` upgrade. The runner parses no HTTP at all: it copies bytes. The fallback,
if the frame code grows past a few hundred lines a side, is Rust `yamux` over
`ws_stream_tungstenite`, with a Node yamux proven against it first.

## Flow

1. **Open.** A member presses Preview on an issue whose run holds a worktree, or the run opens it.
   `POST /api/issues/:issueId/preview` creates the record at `starting` and publishes `preview.start`
   to the device room on the runner's control socket.
2. **Start.**
   - The runner starts `command` in `<worktree>/<cwd>`, bound to `127.0.0.1`. A command holding
     `{port}` gets a free port, passed in the command and as `PORT`. A command without one uses the
     fixed `port`, and the runner checks that port is free first (`PORT_IN_USE`).
   - With no setting, the runner reports `facts` (`package.json` and the lockfile names). Core
     runs `detectPreviewSettings` and either sends a second `preview.start` or fails the preview
     with the reason.
3. **Live.** When the port answers, the runner reports `live`, and the runner opens the tunnel
   socket if it has none.
4. **View.**
   - Web asks `POST /api/previews/:id/ticket` (Forge session, `project.read`). It then loads
     `https://<label>.<previewDomain>/__forge_preview/enter?ticket=…` in an iframe, or in a tab of
     its own.
   - Core checks the ticket, sets the viewer cookie, and redirects with `303` to `/`.
   - Every later request is checked against the cookie and the membership, then relayed over a
     tunnel stream.
5. **Edit.**
   - The run edits files and the dev server's hot reload updates the page. That reload is a
     WebSocket upgrade on its own stream (BC-2).
   - A person types a change in the preview's message box: `POST /api/previews/:id/messages`. Core
     sends it to the run's session with the existing `session.send` frame, and the run edits the same
     worktree (BC-6).
6. **Close.**
   - **Approve:** core asks `preview.snapshot.read`, records the patch id of what is being served,
     moves the preview to `approved` and tells the run its lane.
   - **Abandon** stops it, and so does the run ending.
   - **Idle:** after `idleMinutes` without a viewer request, core stops the dev server and moves the
     preview to `idle_closed`. Opening the link again reopens it.
   - A closed link answers a page saying which of these happened (BC-9).

## Tunnel

- **The socket.** The runner opens a second WebSocket, `wss://<core>/ws/preview-tunnel`, with the
  same device bearer as `/ws`, and only while it holds a live preview.
- **Why not the control socket.**
  - The control socket carries JSON text only. Binary messages are dropped on both ends
    (`runner-transport/src/ws.rs`, `core/src/ws/server.ts`).
  - Its outbound side is a latest-wins `watch`, not a queue.
  - A 5 MB bundle on it would hold `agent:start` behind it.
- **BC-5 still holds.** The runner opens no port to the internet. Every byte goes over a connection
  the runner opened to core.
- **Frames.** Each frame is one binary message:
  - The 12-byte header is: version `u8` = 1, type `u8`, flags `u16` = 0, stream id `u32`, length
    `u32`, all big-endian. This is yamux's layout (`hashicorp/yamux` `spec.md`), with version 1 so
    the two cannot be confused.
  - The types are `open` 1, `data` 2, `window` 3, `close` 4 and `reset` 5.
  - The payload of `open` is `{"previewId": "<uuid>"}`.
  - For `window`, `length` is the credit granted. For `reset`, it is the reason code:
    `CONNECT_REFUSED`, `PREVIEW_NOT_RUNNING`, `STREAM_LIMIT`, `PROTOCOL`, `WINDOW_EXCEEDED`,
    `CANCELLED` or `IDLE`.
- **Streams.**
  - Core opens every stream, one per browser TCP connection.
  - The runner connects each one to the preview's loopback port. The port comes from the runner's
    own record and never from the frame.
  - `close` is a half-close. `reset` tears the stream down.
- **HMR.** Vite or Next upgrade on their own path. Node's `upgrade` event hands core the raw socket,
  and the stream carries the WebSocket bytes untouched.
  - Host is rewritten to `localhost:<port>`, so Vite's `server.allowedHosts` passes it (`vitejs/vite`
    `docs/config/server-options.md`). Origin is rewritten the same way when it is the preview origin.
  - Next's `allowedDevOrigins` reads the Origin header. A rewritten Origin passing it is
    **unverified**, so the first probe checks it.
- **Limits** (`TUNNEL_LIMITS`):
  - `data` frames carry at most 64 KiB.
  - Each stream starts with a 256 KiB window and is granted credit back at 128 KiB consumed.
  - A preview holds at most 64 streams and a tunnel at most 512.
  - A stream idle for 300 s is reset.
- **Backpressure.**
  - A sender stops at zero credit.
  - Core stops reading browser sockets while the tunnel's `bufferedAmount` is over 4 MiB.
  - The runner's writer is a bounded `mpsc`, and its TCP reads wait on it.
- **Losing the tunnel.**
  - A dropped tunnel resets every stream. The runner redials with the control socket's backoff.
  - A tunnel away longer than 60 s fails its live previews with `RUNNER_OFFLINE`.
- **Scale.** Core is one process today: rooms and replay are in memory (`core/src/lib/rooms.ts`), so
  the relay keeps its tunnel map in memory too. A second replica needs tunnel affinity, and that is
  not designed here.
- **Mirrors.** The Rust codec mirrors `preview-tunnel.ts` and reads the same fixture file in its
  tests.

## Record and lifecycle

The record is the `previews` table (`previewRecordSchema`). Its machine is `PREVIEW_MACHINE`,
declared with `defineMachine` and registered in `machines.ts` together with the table.

| From | To | Act | Who |
|---|---|---|---|
| starting | live | `preview.live` | kernel, on the runner's `live` report |
| starting, live | failed | `preview.failed` | kernel, with a reason |
| live | idle_closed | `preview.idleClosed` | kernel's idle sweep |
| idle_closed | starting | `preview.reopened` | `project.write` |
| live, idle_closed | approved | `preview.approved` | `previews.approve` |
| starting, live, idle_closed | abandoned | `preview.abandoned` | `project.write`, or the kernel when the run ends |

The failure reasons (`PREVIEW_FAILURE_REASONS`) are the three BC-10 names first — `NO_START_COMMAND`,
`PORT_IN_USE` and `DEV_SERVER_EXITED`, the last with the tail of its output — then
`PORT_UNDECLARED`, `DEV_SERVER_NOT_LISTENING`, `RUNNER_OFFLINE`, `RUNNER_CANNOT_PREVIEW`,
`WORKTREE_GONE` and `PRODUCTION_ENVIRONMENT`.

- A run holds one preview at a time (`PREVIEW_ALREADY_OPEN`).
- An issue with no live run holding a worktree is refused with `PREVIEW_NO_RUN`.
- A chat turn never writes code, so it opens no preview of its own. Chat shows the issue's preview.

## Who may view

- **Members only (BC-4).** The ticket is minted only for a Forge session holding `project.read` on
  the project. It is a one-minute HS256 JWT signed with `JWT_SECRET`, in the style of
  `auth/oauth/state.ts`, with its own `typ`, and it is single-use by `jti`.
- **The viewer cookie.** `forge_preview` is a JWT for the viewer and the preview that lives eight
  hours. It is host-only, `Secure; HttpOnly; SameSite=None; Partitioned`. `Partitioned` (CHIPS) keeps
  it inside Forge's iframe where third-party cookies are blocked.
- **Each request** re-checks the membership, cached for 60 s, and the preview's state.
- **No Forge session reaches project code.**
  - `PREVIEW_DOMAIN` must be a different site from Forge's. Core refuses to serve previews with
    `PREVIEW_DOMAIN_UNCONFIGURED` when it is unset, or when it sits under `AUTH_COOKIE_DOMAIN` or
    under the web origin's parent.
  - Because the site differs, `forge_auth` is never sent to a preview host. For the same reason,
    the project's code cannot ride the viewer's Forge session as a same-site request.
  - The relay removes only `forge_preview` before forwarding. The project's own cookies pass
    through.
- **Framing.**
  - Every relayed response gets `Content-Security-Policy: frame-ancestors <web origin>`. It is added
    beside any CSP the app sends, so both apply.
  - Web adds `frame-src https://*.<previewDomain>` and frames the preview with
    `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"`, without top
    navigation.
- **Reserved paths.** Paths under `/__forge_preview/` belong to Forge and never reach the dev
  server.

## Project settings

- **`preview`** is a key of the project document (`previewSettingsSchema`) with these fields:
  - `command`
  - `port`, or `{port}` in the command
  - `cwd`
  - `idleMinutes`, 5–240, default 30
  - `environment`
- **When unset**, `detectPreviewSettings` reads the `dev` script of `package.json` (BC-11, BC-12).
  - The package manager comes from the `packageManager` field, then the lockfile.
  - Next, Nuxt, Astro, SvelteKit and Vite get `--port {port}`, and npm also gets `--`.
  - A script that fixes its own port keeps it.
  - Anything else is refused by name, never guessed.
  - The runner only reports the facts. Core decides (ADR 0009, thin box agent).
- **`environment`** names the project environment whose variables the dev server gets. One whose
  tier is `production` is refused with `PREVIEW_PRODUCTION_ENVIRONMENT` (BC-13).
- **`fastLane`** (`fastLaneSettingsSchema`) is a key of the project document with these fields:
  - `paths` deployable web-only
  - the extra `kernel`, `migrations`, `permissions` and `security` globs
  - `deployTargets`, the labels of the deploy binding's targets a web-only deploy fans out to

## Fast lane

- **Lane choice (BC-8).** `classifyLane(files, fastLane)` decides from the files of the approved
  snapshot. The change is fast only when every file is inside `paths` and none is caught by a
  full-gate area: the built-in globs plus the project's own. Each file that fails is named with its
  area and glob.
- **Forge's own declaration:**
  - `paths: ["packages/web-v2/src/**", "packages/web-v2/public/**"]`
  - `kernel: ["packages/core/**", "packages/contracts/**", "packages/runner/**"]`
  - `deployTargets: ["web"]`
- **The fast path (BC-7):**
  1. The run commits and rebases on the base.
  2. It runs `FAST_LANE_MERGE_CHECKS`: rebased-on-base, typecheck and the touched files' direct
     tests. It does not run `verify`, integration or review.
  3. Core's merge rule takes a fast report only when the issue's approved preview has the same
     patch id as the merged change (`FAST_LANE_CHANGED_SINCE_APPROVAL`) and the merged files still
     classify fast (`FAST_LANE_NOT_ELIGIBLE`).
  4. The run deploys the web targets only.
- **The web-only deploy guard.** The deploy is refused unless every commit between the web commit
  now served and the new head classifies fast. Otherwise web would ship ahead of a core change it
  needs.
- **The rest is unchanged.** The whole suite still runs nightly and at each cut, and bisects a fast
  merge like any other.

### Design changes this names

- **Issue to release r20, `rule-merge`.** Add the condition "approved preview, fast lane: rebased,
  typecheck, direct tests; no verify, integration, probes or review". Add a step `act-fast-deploy`:
  a web-only deploy, verified by the commit the web build serves.
- **Issue to release r20, `rule-close`.** The approver's pass on the preview is recorded as the
  verdict on the criteria it shows. It counts as independent because the approver is not the run. The
  issue still closes only with a release (Issue lifecycle r14 unchanged).
- **Chat turn r6.** Add a door, "preview", where the message goes to the run holding the preview,
  not to an Assistant or Agent turn. It writes code, through the run, and no record. So the
  confirm-card and never-an-issue rules do not reach it, and it needs `project.write`.
- **Permissions.** Add `previews` to `APPROVAL_RESOURCES`, which makes it admin's by default and a
  member's where the project grants it.

## Criteria

| BC | Where it holds | Lane |
|---|---|---|
| 1 seen live from a Forge link before merge | flow 1–4, `PREVIEW_ROUTES`, record | preview-tunnel, preview-web |
| 2 each edit within seconds | dev server HMR over a tunnel stream; no build in between | preview-tunnel |
| 3 inside the issue or chat and in its own tab | iframe and tab through the ticket | preview-web |
| 4 members only | ticket + viewer cookie + per-request membership | preview-tunnel |
| 5 no port opened on the runner | `/ws/preview-tunnel` dialled out; loopback only | preview-tunnel |
| 6 chat change in the same preview | `messages` → `session.send` to the run | preview-tunnel (core), preview-web (UI) |
| 7 approve → fast lane | snapshot, `classifyLane`, `FAST_LANE_MERGE_CHECKS`, web-only deploy | fast-lane |
| 8 kernel, migrations, permissions, security never fast | `BUILT_IN_FULL_GATE_PATHS` + project areas | fast-lane |
| 9 closes when approved, abandoned or idle; closed link says so | `PREVIEW_MACHINE`, idle sweep, closed page | preview-tunnel, preview-web |
| 10 cannot start → why on the issue | `PREVIEW_FAILURE_REASONS` with `detail` | preview-tunnel, preview-web |
| 11 a project setting, filled from the repository | `previewSettingsSchema`, `detectPreviewSettings` | preview-tunnel (core), preview-web (settings form) |
| 12 any web project on a runner | detection over any `package.json` stack; nothing Forge-specific | preview-tunnel |
| 13 dev environment, never production | `environment` tier check, `PRODUCTION_ENVIRONMENT` | preview-tunnel |

## Honest costs

- **A second site.** Someone has to own a domain, its wildcard DNS and its wildcard certificate,
  and pay for them, only so that previews never share a site with Forge.
- **Our own code to maintain.** The frame codec and stream table are maintained on two sides, in
  TypeScript and Rust, instead of a library. Only the fixture file keeps them agreeing.
- **Traffic through core.** Every preview byte crosses core twice, once in and once out.
- **Restarts drop streams.** A core restart or deploy drops every live stream. Pages reload, and HMR
  reconnects on its own.
- **Load on the runner's box.** Each live preview is a dev server running there, taking memory and
  CPU from the runs beside it until it idles out.
- **Fewer checks on fast changes.** A fast change skips `verify`, integration tests, kept probes and
  review. A defect it carries can reach dev before the nightly suite names it, and the bisect then
  finds it after the fact.
- **A removed member keeps access briefly.** They can keep viewing for up to the 60 s membership
  cache, and the viewer cookie needs no new ticket for eight hours.

## Not decided here

- **Tunnel affinity across core replicas.** Core is one process today.
- **Safari and CHIPS.** Whether Safari keeps a `Partitioned` cookie in the iframe is unverified, and
  the first probe checks it. If it does not, the tab opens alone and the iframe says why.
- **Forge previewing itself.** Its web dev server talks to dev core through
  `E2E_CORE_PROXY_URL`. Signing in inside the preview needs core to set `forge_auth` without
  `Domain` when the request host is not under `AUTH_COOKIE_DOMAIN`. That is a change to
  `credentials/cookie.ts:writeSessionCookie`, on the full lane.
