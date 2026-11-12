import type { CoreGuide } from './types.js';

/** ISS-1225: production monitoring is a Prometheus integration, never code in a project. */
export const MONITORING_GUIDE: CoreGuide = {
  slug: 'monitoring',
  audience: 'agent',
  title: 'Monitoring: watch production on Prometheus',
  summary:
    "Connect the Prometheus you run to Forge, follow the connection's setup list until its readiness reads clean, bind the project with role `monitoring` and register its targets and rules there; a breach that lasts past its `for` arrives as one feedback item. Internal ports reach it through a Prometheus agent on the project's host. Never a hand-built watch.",
  version: 3,
  body: `## Monitoring: watch production on Prometheus

Monitoring is an integration. You run a Prometheus (any 2.x from 2.45, or 3.x), connect it to Forge
once, set it up as the connection's setup list says, and bind each project to the connection. Forge
bundles no Prometheus. A project never builds its own watch, in its code or as a script schedule:
its binding says what to watch, and a breach comes back as feedback. A check no standard tool does
(a business read) stays a script schedule (\`GET /api/guides/script-schedules.md\`).

### 1. Connect your Prometheus
\`POST /api/integration-connections\`, provider \`prometheus\`:

\`\`\`json
{ "provider": "prometheus",
  "config": { "prometheusUrl": "https://prom.example.com", "prometheusUser": "forge", "ruler": "file" },
  "secrets": { "prometheusPassword": "<the password its web.yml will admit>" } }
\`\`\`

- Forge calls the server as that basic-auth user. A connection without both is refused
  \`MONITORING_SERVER_UNAUTHENTICATED\`: Forge sends no project's data to an open endpoint.
- \`ruler\` says how the server takes a project's rules: \`file\` (it pulls Forge's rule file and
  reloads), \`mimir\` (Forge pushes each group to the Mimir or Cortex ruler at \`rulerUrl\`;
  \`tenant\` sets \`X-Scope-OrgID\`) or \`none\` (no rules; a binding with some is refused
  \`MONITORING_BACKEND_TAKES_NO_RULES\`).

### 2. Set the server up
\`GET /api/integration-connections/:id/monitoring/setup\` renders every change the server takes, for
this connection, with Forge's real URLs and the connection's id. Follow it in order:

- a. a \`web.yml\` with \`basic_auth_users\` (bcrypt of the password) and \`--web.config.file\`;
- b. \`--web.enable-remote-write-receiver\`, only once a project runs a host agent;
- c. \`--web.enable-lifecycle\`;
- d. the \`forge-scrape\` and \`forge-probe\` jobs, discovering targets from Forge, and a blackbox
  exporter beside the server;
- e. \`rule_files\` naming Forge's rules directory, and a sync that pulls the rule file, runs
  \`promtool check rules\`, swaps it in and reloads;
- f. an Alertmanager routing every alert to Forge, and \`alerting.alertmanagers\` pointing at it.

The list names files, never a secret. Mint the two tokens it reads from them, each shown once:
\`POST /api/integration-connections/:id/monitoring/tokens/sd\` (the server's, for discovery and the
rule file) and \`POST /api/integration-connections/:id/monitoring/tokens/alerts\` (the
Alertmanager's). A new one replaces the old.

Then read what the server can do: \`POST /api/integration-connections/:id/monitoring/readiness\`
reads it now from the server's own status API, and \`GET /api/integration-connections/:id/monitoring\`
shows the last read (Forge also reads it on save and before each binding). Each of \`authenticated\`,
\`remoteWriteReceiver\`, \`lifecycle\`, \`ruleFiles\`, \`discovery\` and \`alertmanager\` is
\`true\` once its step is done; \`null\` means it could not be read, and is never taken as done.

### 3. Bind the project
\`POST /api/integration-connections/:id/bindings\`, or later \`PUT /api/projects/:id/bindings/:bindingId\`:
role \`monitoring\`, and a target naming what to watch.

\`\`\`json
"target": {
  "provider": "prometheus",
  "scrape": [{ "name": "api", "url": "https://api.example.com/metrics", "interval": "30s" }],
  "probe":  [{ "name": "site", "url": "https://example.com/health", "module": "http_2xx" }],
  "agent":  { "enabled": true },
  "rules":  [{ "name": "api-p95", "kind": "latency_quantile_above", "target": "api",
               "metric": "http_request_duration_seconds", "quantile": 0.95, "threshold": 1.5,
               "for": "5m", "severity": "high" }]
}
\`\`\`

- \`scrape\` is a metrics endpoint the server can reach; \`probe\` a URL your blackbox exporter
  asks (\`module\` \`http_2xx\`, the default, or \`tcp_connect\`). Names are \`[a-z0-9-]\`, up to 40,
  unique in their list.
- A rule's \`target\` names a scrape, a probe for \`probe_failed\`, or \`agent\` for what the host
  agent sends.
- A rule's \`kind\` is one of: \`target_down\` (a scrape), \`probe_failed\` (a probe),
  \`latency_quantile_above\` (a histogram \`metric\`, \`quantile\`, seconds), \`error_ratio_above\` (a
  counter with a \`code\` or \`status\` label, 0..1), \`disk_free_below\` (node_exporter, 0..1),
  \`series_above\` (\`metric\`, \`threshold\`). Forge writes the PromQL, scoped to the project; raw
  PromQL is not taken.
- \`for\` is at least \`1m\`, two evaluations: a breach has to outlast one. \`severity\` is \`low\`,
  \`medium\` or \`high\`.
- Refused by name, nothing saved: \`MONITORING_RULE_KIND_UNKNOWN\`, \`MONITORING_RULE_TARGET_UNKNOWN\`,
  \`MONITORING_FOR_TOO_SHORT\`, \`MONITORING_NAME_TAKEN\`, \`MONITORING_BACKEND_TAKES_NO_RULES\`,
  \`MONITORING_RULES_REFUSED\`; another role, \`BINDING_ROLE_UNSUPPORTED\`.
- And what the server cannot do yet, each naming its setup step: \`MONITORING_SERVER_UNAUTHENTICATED\`
  (a), \`MONITORING_REMOTE_WRITE_DISABLED\` for the agent (b), \`MONITORING_DISCOVERY_NOT_WIRED\` for
  a scrape or probe (d), \`MONITORING_RULES_NOT_WIRED\` for rules on a \`file\` ruler (c, e), and
  \`MONITORING_NO_ALERTMANAGER\` for any rules (f). A binding watching nothing is taken as it is.

### 4. Internal ports: the host agent
A port the server cannot reach is scraped by a Prometheus agent on the project's host, which pushes
through Forge to the connection's remote-write receiver (step b). It is set up on the project's host,
never in the project's repo; the agent's own version is pinned below, whatever 2.x or 3.x the
central server runs.

1. A project admin mints the token: \`POST /api/projects/:id/monitoring/agent-token\`. It is shown
   once; a new one replaces the old. A project binding no connection is refused
   \`MONITORING_NOT_CONNECTED\`. Put it in a file on the host, readable by the agent only.
2. Run the agent beside the services:

\`\`\`yaml
# docker-compose on the host
prometheus-agent:
  image: prom/prometheus:v3.5.0
  command: ["--agent", "--config.file=/etc/prometheus/agent.yml"]
  volumes:
    - ./agent.yml:/etc/prometheus/agent.yml:ro
    - ./forge-agent-token:/etc/prometheus/forge-agent-token:ro
  restart: unless-stopped
\`\`\`

\`\`\`yaml
# agent.yml
global:
  scrape_interval: 30s
  external_labels:
    forge_project: <project slug>
scrape_configs:
  - job_name: api
    static_configs: [{ targets: ["api:9090"] }]
  - job_name: node
    static_configs: [{ targets: ["node-exporter:9100"] }]
remote_write:
  - url: https://<forge host>/api/monitoring/write
    authorization:
      credentials_file: /etc/prometheus/forge-agent-token
\`\`\`

A series without \`forge_project\` set to this project's slug is refused
\`MONITORING_SERIES_FOREIGN_PROJECT\`, nothing forwarded; a wrong token \`MONITORING_TOKEN_INVALID\`.

### Alerts arrive as feedback
The connection's Alertmanager posts to Forge with its \`alerts\` token. Each firing alert files one
feedback item on the project its \`forge_project\` label names, among the projects bound to that
connection, screen \`monitoring\`. A repeat of the same alert joins it, never a
twin, and its resolution is recorded on it. Triage routes it to the project's master like any other
feedback. What is registered, the rules as rendered, whether they loaded, what is firing, and what
the server cannot do for the project (with no Alertmanager attached, \`MONITORING_NO_ALERTMANAGER\`:
alerts cannot reach Forge): \`GET /api/projects/:id/monitoring\`.

### Check it
Plant a breach: set a rule's threshold below the live value, wait past its \`for\`, and see exactly
one feedback item. Put the threshold back.`,
};
