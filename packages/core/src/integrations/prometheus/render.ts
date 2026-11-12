/**
 * What core renders from a project's monitoring binding (ISS-1225), pure: the rule group the
 * connection's ruler holds for the project and the `http_sd_configs` target groups its Prometheus
 * discovers. Every expression is
 * one of the closed kinds, scoped to `{forge_project="<slug>"}`, so a project's rule never reads
 * another project's series; every alert carries its project as a label, so its feedback lands there.
 */

import {
  MONITORING_AGENT_TARGET,
  MONITORING_PROJECT_LABEL,
  MONITORING_TARGET_LABEL,
  type MonitoringConfig,
  type MonitoringRule,
  type MonitoringTargetGroup,
} from '@forge/contracts/monitoring';

/** The window a rate is read over; at least four of Prometheus' 30 s scrapes. */
const RATE_WINDOW = '5m';
/** Filesystems a host's disk rule never reads: memory and container layers. */
const VIRTUAL_FS = 'fstype!~"tmpfs|overlay|squashfs"';

/** A slug and a registered name are `[a-z0-9-]`, so a label value needs no escaping. */
function selector(slug: string, rule: MonitoringRule, extra: string[] = []): string {
  const labels = [`${MONITORING_PROJECT_LABEL}="${slug}"`];
  if (rule.target !== MONITORING_AGENT_TARGET) {
    labels.push(`${MONITORING_TARGET_LABEL}="${rule.target}"`);
  }
  return `{${[...labels, ...extra].join(',')}}`;
}

/** The PromQL a rule of each kind is, its fields checked by the schema before it gets here. */
export function ruleExpression(slug: string, rule: MonitoringRule): string {
  const sel = (extra: string[] = []) => selector(slug, rule, extra);
  const t = String(rule.threshold);
  const m = rule.metric ?? '';
  switch (rule.kind) {
    case 'target_down':
      return `up${sel()} == 0`;
    case 'probe_failed':
      return `probe_success${sel()} == 0`;
    case 'latency_quantile_above':
      return `histogram_quantile(${rule.quantile}, sum by (le) (rate(${m}_bucket${sel()}[${RATE_WINDOW}]))) > ${t}`;
    case 'error_ratio_above': {
      const errors = (label: string) =>
        `sum(rate(${m}${sel([`${label}=~"5.."`])}[${RATE_WINDOW}]))`;
      return `(${errors('code')} or ${errors('status')}) / sum(rate(${m}${sel()}[${RATE_WINDOW}])) > ${t}`;
    }
    case 'disk_free_below':
      return `node_filesystem_avail_bytes${sel([VIRTUAL_FS])} / node_filesystem_size_bytes${sel([VIRTUAL_FS])} < ${t}`;
    case 'series_above':
      return `${m}${sel()} > ${t}`;
  }
}

/** One Prometheus rule group, as a rule file and the ruler APIs both carry it. */
export interface RuleGroup {
  name: string;
  rules: {
    alert: string;
    expr: string;
    for: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  }[];
}

/** The group a project's rules are held under, the same name in a file and at a ruler. */
export const ruleGroupName = (slug: string) => `forge-${slug}`;

/** The rule group of one project, or null where it registers no rule. */
export function renderRuleGroup(
  slug: string,
  monitoring: MonitoringConfig | undefined,
): RuleGroup | null {
  const rules = monitoring?.rules ?? [];
  if (rules.length === 0) return null;
  return {
    name: ruleGroupName(slug),
    rules: rules.map((rule) => ({
      alert: rule.name,
      expr: ruleExpression(slug, rule),
      for: rule.for,
      labels: {
        [MONITORING_PROJECT_LABEL]: slug,
        forge_rule: rule.name,
        severity: rule.severity,
      },
      annotations: { summary: `${rule.kind} on ${rule.target}` },
    })),
  };
}

/** A rule file holding `groups`: JSON, which YAML reads as it is. */
export const ruleFileOf = (groups: readonly RuleGroup[]) =>
  `${JSON.stringify({ groups }, null, 2)}\n`;

const own = (slug: string, name: string) => ({
  [MONITORING_PROJECT_LABEL]: slug,
  [MONITORING_TARGET_LABEL]: name,
});

/** The scrape target groups of every monitored project: one per endpoint, its address and path as labels. */
export function scrapeGroups(
  projects: readonly { slug: string; monitoring: MonitoringConfig }[],
): MonitoringTargetGroup[] {
  return projects.flatMap(({ slug, monitoring }) =>
    (monitoring.scrape ?? []).map((scrape) => {
      const url = new URL(scrape.url);
      const labels: Record<string, string> = {
        ...own(slug, scrape.name),
        __scheme__: url.protocol.replace(':', ''),
        __metrics_path__: url.pathname || '/metrics',
      };
      for (const [key, value] of url.searchParams) labels[`__param_${key}`] = value;
      if (scrape.interval) labels.__scrape_interval__ = scrape.interval;
      return { targets: [url.host], labels };
    }),
  );
}

/** The probe target groups: the URL the blackbox exporter is handed, and its module. */
export function probeGroups(
  projects: readonly { slug: string; monitoring: MonitoringConfig }[],
): MonitoringTargetGroup[] {
  return projects.flatMap(({ slug, monitoring }) =>
    (monitoring.probe ?? []).map((probe) => {
      const module = probe.module ?? 'http_2xx';
      const target = module === 'tcp_connect' ? new URL(probe.url).host : probe.url;
      return { targets: [target], labels: { ...own(slug, probe.name), __param_module: module } };
    }),
  );
}
