import type { CoreGuide } from './types.js';

/** ISS-1225: production monitoring is Forge's Prometheus capability, never code in a project. */
export const MONITORING_GUIDE: CoreGuide = {
  slug: 'monitoring',
  audience: 'agent',
  title: 'Monitoring: watch production on Prometheus',
  summary:
    "Forge runs Prometheus, Alertmanager and a blackbox prober for every project. Register targets and rules in the project document; a breach that lasts past its `for` arrives as one feedback item. Internal ports reach it through a Prometheus agent on the project's host. Never a hand-built watch.",
  version: 1,
  body: `## Monitoring: watch production on Prometheus

Forge runs Prometheus, Alertmanager and a blackbox prober for every project. A project never builds
its own watch, in its code or as a script schedule: it registers what to watch, and a breach comes
back as feedback. A check no standard tool does (a business read) stays a script schedule
(\`GET /api/guides/script-schedules.md\`).

### Register targets and rules
In the project document, block \`monitoring\`: \`GET /api/projects/:id/config\`, then
\`PUT /api/projects/:id/config { baseRevision, document }\` with the revision you read.

\`\`\`json
"monitoring": {
  "scrape": [{ "name": "api", "url": "https://api.example.com/metrics", "interval": "30s" }],
  "probe":  [{ "name": "site", "url": "https://example.com/health", "module": "http_2xx" }],
  "agent":  { "enabled": true },
  "rules":  [{ "name": "api-p95", "kind": "latency_quantile_above", "target": "api",
               "metric": "http_request_duration_seconds", "quantile": 0.95, "threshold": 1.5,
               "for": "5m", "severity": "high" }]
}
\`\`\`

- \`scrape\` is a Prometheus metrics endpoint Forge can reach; \`probe\` a URL the prober asks
  (\`module\` \`http_2xx\`, the default, or \`tcp_connect\`). Names are \`[a-z0-9-]\`, up to 40,
  unique in their list.
- A rule's \`target\` names a scrape, a probe for \`probe_failed\`, or \`agent\` for what the host
  agent sends.
- A rule's \`kind\` is one of: \`target_down\` (a scrape), \`probe_failed\` (a probe),
  \`latency_quantile_above\` (a histogram \`metric\`, \`quantile\`, seconds), \`error_ratio_above\` (a
  counter with a \`code\` or \`status\` label, 0..1), \`disk_free_below\` (node_exporter, 0..1),
  \`series_above\` (\`metric\`, \`threshold\`). Core writes the PromQL, scoped to the project; raw
  PromQL is not taken.
- \`for\` is at least \`1m\`, two evaluations: a breach has to outlast one. \`severity\` is \`low\`,
  \`medium\` or \`high\`.
- Refused by name, nothing saved: \`MONITORING_RULE_KIND_UNKNOWN\`, \`MONITORING_RULE_TARGET_UNKNOWN\`,
  \`MONITORING_FOR_TOO_SHORT\`, \`MONITORING_NAME_TAKEN\`, \`MONITORING_RELOAD_FAILED\` (Prometheus refused
  the rules; the previous ones stand), \`MONITORING_NOT_DEPLOYED\`.

### Internal ports: the host agent
A port Forge cannot reach is scraped by a Prometheus agent on the project's host, which pushes to
Forge. It is set up on the host, never in the project's repo.

1. A project admin mints the token: \`POST /api/projects/:id/monitoring/agent-token\`. It is shown
   once; a new one replaces the old. Put it in a file on the host, readable by the agent only.
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
Each firing alert files one feedback item on the project, source \`monitoring\`. A repeat of the same
alert joins it, never a twin, and its resolution is recorded on it. Triage routes it to the project's
master like any other feedback. What is registered, the rules as rendered and what is firing:
\`GET /api/projects/:id/monitoring\`.

### Check it
Plant a breach: set a rule's threshold below the live value, wait past its \`for\`, and see exactly
one feedback item. Put the threshold back.`,
};
