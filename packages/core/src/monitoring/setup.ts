/**
 * The changes a monitoring connection's own server takes before Forge can use it (ISS-1225, owner
 * 2026-11-12), rendered for one connection: Forge's real URLs and the connection's id, never a token
 * or password, each read from a file on the host. Every directive is one Prometheus 2.45 already
 * takes (http_sd, `credentials_file`, the remote-write receiver flag), so a 2.x server follows it as
 * a v3 one does.
 */

import {
  MONITORING_RULES_DIR,
  type MonitoringRuler,
  type MonitoringSetupStep,
  monitoringConnectionDoor,
} from '@forge/contracts/monitoring';

/** Pinned beside the server: what the setup list's probe and alert routing run on. */
const BLACKBOX_IMAGE = 'prom/blackbox-exporter:v0.27.0';
const ALERTMANAGER_IMAGE = 'prom/alertmanager:v0.28.1';

const SD_TOKEN_FILE = '/etc/prometheus/forge-sd-token';
const PASSWORD_FILE = '/etc/prometheus/forge-password';
const ALERTS_TOKEN_FILE = '/etc/alertmanager/forge-alerts-token';

export interface SetupInput {
  connectionId: string;
  /** Forge's public origin, which the server reaches Forge by. */
  origin: string;
  user: string;
  ruler: MonitoringRuler;
  /** Whether a project bound to this connection runs a host agent. */
  hostAgent: boolean;
}

export function monitoringSetup(input: SetupInput): MonitoringSetupStep[] {
  const { connectionId, origin, user } = input;
  const door = (d: Parameters<typeof monitoringConnectionDoor>[1]) =>
    `${origin}${monitoringConnectionDoor(connectionId, d)}`;
  const tokens = `${origin}/api/integration-connections/${connectionId}/monitoring/tokens`;
  return [
    {
      step: 'a',
      title: 'Answer only the connection, by basic auth',
      file: '/etc/prometheus/web.yml',
      content: `# The bcrypt of the connection's password, made on the host: htpasswd -nBC 10 "" | tr -d ':\\n'
basic_auth_users:
  ${user}: <bcrypt of the connection's password>`,
    },
    {
      step: 'a',
      title: 'Load it, and let the self-scrape authenticate',
      file: null,
      content: `--web.config.file=/etc/prometheus/web.yml

# prometheus.yml: the server's own scrape now presents the user too
#   - job_name: prometheus
#     basic_auth: { username: ${user}, password_file: ${PASSWORD_FILE} }
#     static_configs: [{ targets: ["localhost:9090"] }]
# ${PASSWORD_FILE} holds the connection's password, readable by Prometheus only.`,
    },
    {
      step: 'b',
      title: input.hostAgent
        ? "Receive the host agents' remote writes"
        : 'Receive remote writes, only once a project runs a host agent',
      file: null,
      content: '--web.enable-remote-write-receiver',
    },
    {
      step: 'c',
      title: 'Take a reload over HTTP',
      file: null,
      content: '--web.enable-lifecycle',
    },
    {
      step: 'd',
      title: "Discover the bound projects' targets from Forge",
      file: '/etc/prometheus/prometheus.yml',
      content: `# ${SD_TOKEN_FILE}: the connection's sd token, minted once with POST ${tokens}/sd
global:
  scrape_interval: 30s
  evaluation_interval: 30s
scrape_configs:
  - job_name: forge-scrape
    http_sd_configs:
      - url: ${door('targets?job=scrape')}
        authorization:
          credentials_file: ${SD_TOKEN_FILE}
  - job_name: forge-probe
    metrics_path: /probe
    http_sd_configs:
      - url: ${door('targets?job=probe')}
        authorization:
          credentials_file: ${SD_TOKEN_FILE}
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115`,
    },
    {
      step: 'd',
      title: 'Run a blackbox exporter beside it',
      file: 'docker-compose.yml',
      content: `blackbox-exporter:
  image: ${BLACKBOX_IMAGE}
  restart: unless-stopped`,
    },
    ...rulesSteps(input, door('rules')),
    {
      step: 'f',
      title: 'Route alerts to Forge through an Alertmanager',
      file: '/etc/alertmanager/alertmanager.yml',
      content: `# ${ALERTS_TOKEN_FILE}: the connection's alerts token, minted once with POST ${tokens}/alerts
route:
  receiver: forge
  group_by: [forge_project, alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
receivers:
  - name: forge
    webhook_configs:
      - url: ${door('alerts')}
        send_resolved: true
        http_config:
          authorization:
            credentials_file: ${ALERTS_TOKEN_FILE}`,
    },
    {
      step: 'f',
      title: 'Run it beside the server',
      file: 'docker-compose.yml',
      content: `alertmanager:
  image: ${ALERTMANAGER_IMAGE}
  command: ["--config.file=/etc/alertmanager/alertmanager.yml"]
  volumes:
    - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    - ./forge-alerts-token:${ALERTS_TOKEN_FILE}:ro
  restart: unless-stopped`,
    },
    {
      step: 'f',
      title: "Send the server's alerts to it",
      file: '/etc/prometheus/prometheus.yml',
      content: `alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]`,
    },
  ];
}

function rulesSteps(input: SetupInput, rulesUrl: string): MonitoringSetupStep[] {
  if (input.ruler !== 'file') {
    return [
      {
        step: 'e',
        title:
          input.ruler === 'mimir'
            ? "Nothing here: Forge pushes each project's rules to the connection's ruler"
            : 'Nothing here: this connection takes no rules',
        file: null,
        content: '',
      },
    ];
  }
  return [
    {
      step: 'e',
      title: "Load Forge's rule file",
      file: '/etc/prometheus/prometheus.yml',
      content: `rule_files:
  - ${MONITORING_RULES_DIR}/*.yml`,
    },
    {
      step: 'e',
      title: 'Pull it, check it, swap it in and reload, each minute',
      file: '/usr/local/bin/forge-rules-sync',
      content: `#!/bin/sh
# cron: * * * * * /usr/local/bin/forge-rules-sync
set -eu
dir=${MONITORING_RULES_DIR}
next="$dir/forge.yml.next"
curl -fsS -H "Authorization: Bearer $(cat ${SD_TOKEN_FILE})" -o "$next" "${rulesUrl}"
promtool check rules "$next"
if cmp -s "$next" "$dir/forge.yml"; then rm -f "$next"; exit 0; fi
mv "$next" "$dir/forge.yml"
curl -fsS -X POST -u "${input.user}:$(cat ${PASSWORD_FILE})" http://localhost:9090/-/reload`,
    },
  ];
}
