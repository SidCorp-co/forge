/**
 * Whether a window fires, and on what. The thresholds are the project's; where it declares none
 * there is no answer, because a default would silently change a project that never asked for one.
 */

const HOUR = 3_600_000;

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * @param {{ members: { issue: string, arrivedAt: string, priority?: string }[],
 *   thresholds?: { count?: number, waitHours?: number, source?: string }, now: Date }} input
 * @returns {{ refusal: string } | { fired: boolean, by: string[], oldest: object|null, waitedHours: number }}
 */
export function decideFire({ members, thresholds, now }) {
  const missing = [];
  if (!positive(thresholds?.count)) missing.push('`thresholds.count`');
  if (!positive(thresholds?.waitHours)) missing.push('`thresholds.waitHours`');
  if (typeof thresholds?.source !== 'string' || thresholds.source.trim() === '') {
    missing.push('`thresholds.source`, where the two were read');
  }
  if (missing.length > 0) {
    return {
      refusal:
        `the window declares no ${missing.join(' and no ')}. A project that has not declared its ` +
        'thresholds is one this window refuses to act for; nothing here carries a default.',
    };
  }
  let oldest = null;
  for (const m of members) {
    const at = Date.parse(m.arrivedAt);
    if (Number.isNaN(at)) {
      return {
        refusal: `${m.issue} carries no readable \`arrivedAt\` (${m.arrivedAt}), so its wait cannot be measured`,
      };
    }
    if (!oldest || at < oldest.at) oldest = { issue: m.issue, at };
  }
  const waitedHours = oldest ? (now.getTime() - oldest.at) / HOUR : 0;
  const by = [];
  const critical = members.filter((m) => m.priority === 'critical').map((m) => m.issue);
  if (critical.length > 0) by.push(`critical (${critical.join(', ')})`);
  if (members.length >= thresholds.count)
    by.push(`count (${members.length} of ${thresholds.count})`);
  if (oldest && waitedHours >= thresholds.waitHours) {
    by.push(
      `wait (${oldest.issue} has waited ${waitedHours.toFixed(1)}h of ${thresholds.waitHours}h)`,
    );
  }
  return {
    fired: by.length > 0,
    by,
    oldest: oldest && { issue: oldest.issue, arrivedAt: new Date(oldest.at).toISOString() },
    waitedHours,
  };
}
