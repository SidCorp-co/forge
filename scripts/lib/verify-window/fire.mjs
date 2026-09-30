/**
 * Whether a window fires, and on what. The thresholds are the project's, named as the release train
 * names them (`docs/proposals/release-train.md`): `size`, `minutes`, and an optional `maxSize`
 * ceiling. Where the project declares none there is no answer, because a default would silently
 * change a project that never asked for one.
 */

const MINUTE = 60_000;

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * @param {{ members: { issue: string, arrivedAt: string, priority?: string }[],
 *   thresholds?: { size?: number, minutes?: number, maxSize?: number, source?: string }, now: Date }} input
 * @returns {{ refusal: string } | { fired: boolean, by: string[], oldest: object|null, waitedMinutes: number }}
 */
export function decideFire({ members, thresholds, now }) {
  const missing = [];
  if (!positive(thresholds?.size)) missing.push('`thresholds.size`');
  if (!positive(thresholds?.minutes)) missing.push('`thresholds.minutes`');
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
  const { size, minutes, maxSize } = thresholds;
  if (maxSize !== undefined && (!positive(maxSize) || maxSize < size)) {
    return {
      refusal: `\`thresholds.maxSize\` is ${maxSize}; it must be a ceiling at or above \`size\` (${size})`,
    };
  }
  if (maxSize !== undefined && members.length > maxSize) {
    return {
      refusal: `the window holds ${members.length} members and \`thresholds.maxSize\` is ${maxSize}: split it rather than validate more than attribution can carry`,
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
  const waitedMinutes = oldest ? (now.getTime() - oldest.at) / MINUTE : 0;
  const by = [];
  const critical = members.filter((m) => m.priority === 'critical').map((m) => m.issue);
  if (critical.length > 0) by.push(`critical (${critical.join(', ')})`);
  if (members.length >= size) by.push(`size (${members.length} of ${size})`);
  if (oldest && waitedMinutes >= minutes) {
    by.push(`minutes (${oldest.issue} has waited ${Math.floor(waitedMinutes)} of ${minutes})`);
  }
  return {
    fired: by.length > 0,
    by,
    oldest: oldest && { issue: oldest.issue, arrivedAt: new Date(oldest.at).toISOString() },
    waitedMinutes,
  };
}
