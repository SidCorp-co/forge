// The first lines of a status report as one recipient reads it, in their language: what shipped,
// what is late, who is waited on, the next release with its date, and what changed since the last
// report. Every figure is the stored report's or the diff's; only the words around them translate.

import type { ProjectStatus } from '@forge/contracts/project-status';
import { deliveryDateOf, type StatusReportDiff } from '@forge/contracts/status-reports';
import copy from './digest-copy.json' with { type: 'json' };

export type DigestLanguage = keyof typeof copy;
type DigestKey = keyof (typeof copy)['en'];

const KEYS_SHOWN = 3;

function line(language: DigestLanguage, key: DigestKey, vars: Record<string, string | number>) {
  return copy[language][key].replace(/\{(\w+)\}/g, (all, name: string) =>
    vars[name] === undefined ? all : String(vars[name]),
  );
}

function dayOf(iso: string, language: DigestLanguage, timeZone: string | null): string {
  return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-GB', {
    dateStyle: 'medium',
    timeZone: timeZone ?? 'UTC',
  }).format(new Date(iso));
}

const keysOf = (keys: readonly string[]) =>
  keys.length > KEYS_SHOWN
    ? `${keys.slice(0, KEYS_SHOWN).join(', ')}, +${keys.length - KEYS_SHOWN}`
    : keys.join(', ');

export function digestText(
  s: ProjectStatus,
  diff: { previousAsOf: string; diff: StatusReportDiff } | null,
  language: DigestLanguage,
  timeZone: string | null,
): { title: string; body: string } {
  const day = (iso: string) => dayOf(iso, language, timeZone);
  const lines: string[] = [];
  lines.push(
    s.shipped.releaseCount > 0
      ? line(language, 'shipped', {
          days: s.days,
          releases: s.shipped.releaseCount,
          issues: s.shipped.issueCount,
        })
      : line(language, 'shippedNone', { days: s.days }),
  );
  lines.push(
    s.late.items.length > 0
      ? line(language, 'late', {
          n: s.late.items.length,
          keys: keysOf(s.late.items.map((l) => l.key)),
        })
      : line(language, 'lateNone', {}),
  );
  lines.push(
    s.waits.peopleCount > 0
      ? line(language, 'waits', {
          n: s.waits.peopleCount,
          keys: keysOf(s.waits.people.map((w) => w.key)),
        })
      : line(language, 'waitsNone', {}),
  );
  const n = s.nextRelease;
  const shippedAt = n.forecast?.delivery?.shipped?.at ?? null;
  const date = deliveryDateOf(n.forecast?.delivery ?? null);
  lines.push(
    n.version === null
      ? line(language, 'nextNone', {})
      : shippedAt
        ? line(language, 'nextShipped', { version: n.version, date: day(shippedAt) })
        : date
          ? line(language, 'next', { version: n.version, date: day(date) })
          : line(language, 'nextUndated', { version: n.version }),
  );
  lines.push(
    diff
      ? line(language, 'since', {
          date: day(diff.previousAsOf),
          shipped: diff.diff.shipped.length,
          late: diff.diff.newlyLate.length,
          cleared: diff.diff.noLongerWaiting.length,
          moved: diff.diff.moved.length,
        })
      : line(language, 'first', {}),
  );
  return {
    title: line(language, 'title', { project: s.name, date: day(s.asOf) }),
    body: lines.join('\n'),
  };
}
