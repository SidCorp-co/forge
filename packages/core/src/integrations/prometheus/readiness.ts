/**
 * What a monitoring binding asks of its connection's server, against what the server was read to do
 * (ISS-1225, owner 2026-11-12). Each thing the binding needs and the server does not do, or could not
 * be read to do, is one fault by name; nothing is assumed and nothing is skipped quietly.
 */

import {
  MONITORING_RULES_DIR,
  type MonitoringConfig,
  type MonitoringFault,
  type MonitoringReadiness,
  type MonitoringRuler,
} from '@forge/contracts/monitoring';

/** Whether the binding watches anything the server has to do something for. */
export function watchesAnything(watched: MonitoringConfig): boolean {
  return (
    (watched.scrape?.length ?? 0) > 0 ||
    (watched.probe?.length ?? 0) > 0 ||
    watched.agent?.enabled === true ||
    (watched.rules?.length ?? 0) > 0
  );
}

const unknownBecause = (r: MonitoringReadiness) =>
  r.unreadable ? `could not be read (${r.unreadable})` : 'could not be read';

export function readinessFaults(
  r: MonitoringReadiness,
  watched: MonitoringConfig,
  ruler: MonitoringRuler,
): MonitoringFault[] {
  const out: MonitoringFault[] = [];
  if (r.authenticated !== true) {
    out.push({
      code: 'MONITORING_SERVER_UNAUTHENTICATED',
      path: '',
      detail:
        r.authenticated === false
          ? "the connection's server answers without credentials, and Forge sends no project's data to an open endpoint: give it a web.yml with basic_auth_users (GET /api/integration-connections/:id/monitoring/setup, step a)"
          : `whether the connection's server refuses a call without credentials ${unknownBecause(r)}`,
    });
  }
  const sd = (job: 'scrape' | 'probe') => {
    if (!(watched[job]?.length ?? 0) || r.discovery?.[job] === true) return;
    out.push({
      code: 'MONITORING_DISCOVERY_NOT_WIRED',
      path: `/${job}`,
      detail:
        r.discovery === null
          ? `the server's config ${unknownBecause(r)}, so its forge-${job} job is unknown`
          : `the server's config holds no forge-${job} job discovering this connection's targets (setup step d)`,
    });
  };
  sd('scrape');
  sd('probe');
  if (watched.agent?.enabled === true && r.remoteWriteReceiver !== true) {
    out.push({
      code: 'MONITORING_REMOTE_WRITE_DISABLED',
      path: '/agent',
      detail:
        r.remoteWriteReceiver === false
          ? 'the server runs without --web.enable-remote-write-receiver, so a host agent has nowhere to write (setup step b)'
          : `whether the server receives remote writes ${unknownBecause(r)}`,
    });
  }
  if (!(watched.rules?.length ?? 0)) return out;
  if (ruler === 'file') {
    const missing = [
      r.ruleFiles === true
        ? null
        : r.ruleFiles === false
          ? `rule_files names no file under ${MONITORING_RULES_DIR} (setup step e)`
          : `rule_files ${unknownBecause(r)}`,
      r.lifecycle === true
        ? null
        : r.lifecycle === false
          ? 'the server runs without --web.enable-lifecycle, so a pulled rule file is never reloaded (setup step c)'
          : `--web.enable-lifecycle ${unknownBecause(r)}`,
    ].filter((m): m is string => m !== null);
    if (missing.length > 0) {
      out.push({ code: 'MONITORING_RULES_NOT_WIRED', path: '/rules', detail: missing.join('; ') });
    }
  }
  if (r.alertmanager !== true) out.push(noAlertmanager(r));
  return out;
}

/** The server sends its alerts to no Alertmanager, so none reaches Forge. */
export function noAlertmanager(r: MonitoringReadiness): MonitoringFault {
  return {
    code: 'MONITORING_NO_ALERTMANAGER',
    path: '/rules',
    detail:
      r.alertmanager === false
        ? 'the server has no Alertmanager attached, so an alert cannot reach Forge (setup step f)'
        : `whether an Alertmanager is attached ${unknownBecause(r)}, so an alert may never reach Forge`,
  };
}
