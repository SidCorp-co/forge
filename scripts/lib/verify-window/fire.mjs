/**
 * Whether a window fires, and on what. The thresholds are the project's, named as the release train
 * names them (`docs/proposals/release-train.md`): `size`, `minutes`, and an optional `maxSize`
 * ceiling. Where the project declares none there is no answer, because a default would silently
 * change a project that never asked for one.
 */

const MINUTE = 60_000;

/** Why `value`, declared as `thresholds.<key>`, is not a threshold, or `null`; `undefined` is absent. */
function invalid(key, value, whole) {
  if (value === undefined) return null;
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    (!whole || Number.isInteger(value));
  return ok
    ? null
    : `\`thresholds.${key}\` is declared as ${JSON.stringify(value)}; it must be a positive ${whole ? 'whole number' : 'number'}`;
}

/**
 * @param {{ members: { issue: string, arrivedAt: string, priority?: string }[],
 *   thresholds?: { size?: number, minutes?: number, maxSize?: number, source?: string }, now: Date }} input
 * @returns {{ refusal: string } | { fired: boolean, by: string[], oldest: object|null, waitedMinutes: number }}
 */
export function decideFire({ members, thresholds, now }) {
  const missing = [];
  if (thresholds?.size === undefined) missing.push('`thresholds.size`');
  if (thresholds?.minutes === undefined) missing.push('`thresholds.minutes`');
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
  const bad =
    invalid('size', thresholds.size, true) ??
    invalid('minutes', thresholds.minutes, false) ??
    invalid('maxSize', thresholds.maxSize, true);
  if (bad) return { refusal: bad };
  const { size, minutes, maxSize } = thresholds;
  if (maxSize !== undefined && maxSize < size) {
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
    if (at > now.getTime()) {
      return {
        refusal: `${m.issue} arrived at ${m.arrivedAt}, after the time the window is judged at (${now.toISOString()}), so its wait cannot be measured`,
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
