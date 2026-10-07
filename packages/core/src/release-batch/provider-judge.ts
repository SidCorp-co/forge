// Each landing against what the provider serves now. A provider keeps one mutable slot per thing —
// a workflow's published graph, the store's one served theme — so a landing is carried where the
// slot serves what it landed, or moved forward from it: went live after the landing was judged or
// recorded. A route or a page is carried where it answers live traffic; a setting where it holds
// the value landed. A landing names no identity of a page's content, so a live page is all it can
// show of one. Anything else is a mismatch naming the issue, the thing and both identities.

import type {
  StorefrontPageReading,
  StorefrontPublishedReading,
  StorefrontRouteReading,
  StorefrontSettingReading,
  StorefrontThemeReading,
} from '../integrations/index.js';
import type {
  KeyedLanding,
  ProviderMismatch,
  SettingLanding,
  ThemeLanding,
  WorkflowLanding,
} from './provider-landings.js';

export type Judged =
  | { carried: true; how: string }
  | { carried: false; mismatch: ProviderMismatch };

const after = (live: string | null, landed: string | null) =>
  live != null && landed != null && Date.parse(live) > Date.parse(landed);

const landedWhen = (landedAt: string | null, from: 'verdict' | 'mark') =>
  landedAt == null
    ? 'its mark records no time'
    : `the landing was ${from === 'verdict' ? 'judged' : 'recorded'} at ${landedAt}`;

function miss(
  landing: { issue: string },
  kind: ProviderMismatch['kind'],
  ref: string,
  fields: Partial<ProviderMismatch> & { why: string },
): Judged {
  return {
    carried: false,
    mismatch: {
      issue: landing.issue,
      kind,
      ref,
      workflow: null,
      workflowCode: null,
      landed: null,
      served: null,
      ...fields,
    },
  };
}

export function judgeWorkflow(
  landing: WorkflowLanding,
  reading: StorefrontPublishedReading | undefined,
  label: string,
): Judged {
  const at = `workflow \`${landing.workflowId}\``;
  const base = { workflow: landing.workflowId, landed: landing.graph };
  if (!reading || reading.kind === 'unreadable' || reading.kind === 'missing') {
    const why = reading?.detail ?? `${label} answered no reading of ${at}`;
    return miss(landing, 'workflow', landing.workflowId, { ...base, why });
  }
  const code = reading.workflowCode;
  if (reading.kind === 'unpublished') {
    if (landing.removed) return { carried: true, how: `publishes no version of ${at}, as removed` };
    return miss(landing, 'workflow', landing.workflowId, {
      ...base,
      workflowCode: code,
      why: `${label} publishes no version of ${at} (\`${code}\`): nothing of it is live`,
    });
  }
  const served = reading.graphVersion;
  if (landing.graph == null) {
    return {
      carried: true,
      how: `publishes ${at} at version ${reading.version} (\`${served}\`); the landing names no graph`,
    };
  }
  if (served.startsWith(landing.graph)) {
    return { carried: true, how: `serves draft \`${served}\` itself` };
  }
  const when = landedWhen(landing.landedAt, landing.from);
  if (after(reading.firstLiveAt, landing.landedAt)) {
    return {
      carried: true,
      how: `serves \`${served}\`, first live at ${reading.firstLiveAt}, after ${when}`,
    };
  }
  const revert =
    reading.firstLiveAt === reading.publishedAt
      ? ''
      : `, republished at ${reading.publishedAt} as a revert to a graph first live then`;
  return miss(landing, 'workflow', landing.workflowId, {
    ...base,
    workflowCode: code,
    served,
    why: `${label} serves version ${reading.version} at \`${served}\`, live since ${reading.firstLiveAt}${revert}, which is not after ${when}, so the published graph cannot carry it`,
  });
}

export function judgeRoute(
  landing: KeyedLanding,
  reading: StorefrontRouteReading | undefined,
  label: string,
): Judged {
  const at = `route \`${landing.id}\``;
  if (!reading || reading.kind === 'unreadable') {
    return miss(landing, 'route', landing.id, {
      why: reading?.detail ?? `${label} answered no reading of ${at}`,
    });
  }
  if (reading.kind === 'missing') {
    if (landing.removed) return { carried: true, how: `holds no ${at}, as removed` };
    return miss(landing, 'route', landing.id, { why: reading.detail });
  }
  const served = `${reading.method} ${reading.path}`.trim();
  if (landing.removed) {
    return reading.kind === 'unpublished'
      ? { carried: true, how: `holds ${at} (${served}) unpublished, as removed` }
      : miss(landing, 'route', landing.id, {
          landed: 'removed',
          served,
          why: `${label} still serves ${at} (${served}), which the landing removed`,
        });
  }
  if (reading.kind === 'unpublished') {
    return miss(landing, 'route', landing.id, {
      served: `${served} (unpublished)`,
      why: `${label} holds ${at} (${served}) unpublished: it answers no live traffic`,
    });
  }
  return { carried: true, how: `serves ${at} (${served} -> \`${reading.workflowCode}\`) live` };
}

export function judgePage(
  landing: KeyedLanding,
  reading: StorefrontPageReading | undefined,
  label: string,
): Judged {
  const at = `page \`${landing.id}\``;
  if (!reading || reading.kind === 'unreadable') {
    return miss(landing, 'page', landing.id, {
      why: reading?.detail ?? `${label} answered no reading of ${at}`,
    });
  }
  if (reading.kind === 'missing') {
    if (landing.removed) return { carried: true, how: `holds no ${at}, as removed` };
    return miss(landing, 'page', landing.id, { why: reading.detail });
  }
  if (reading.kind === 'unpublished') {
    if (landing.removed) return { carried: true, how: `holds ${at} unpublished, as removed` };
    return miss(landing, 'page', landing.id, {
      served: 'unpublished',
      why: `${label} holds ${at} (\`${reading.handle}\`) unpublished: it is not live`,
    });
  }
  if (landing.removed) {
    return miss(landing, 'page', landing.id, {
      landed: 'removed',
      served: `published at ${reading.publishedAt ?? 'an unrecorded time'}`,
      why: `${label} still serves ${at} (\`${reading.handle}\`), which the landing removed`,
    });
  }
  const pending = reading.unpublishedChanges
    ? '; it also holds changes not yet published, which nothing here attributes to this landing'
    : '';
  return {
    carried: true,
    how: `serves ${at} (\`${reading.handle}\`) live, published at ${reading.publishedAt ?? 'an unrecorded time'}${pending}`,
  };
}

/** A theme landing: the served theme is the one landed, holding each file named at its sha-256, or
 *  a theme published after the landing that still holds each file it added or changed. */
export function judgeTheme(
  landing: ThemeLanding,
  reading: StorefrontThemeReading | null,
  label: string,
): Judged[] {
  const at = `theme \`${landing.id}\``;
  if (!reading || reading.kind === 'unreadable') {
    return [
      miss(landing, 'theme', landing.id, {
        landed: landing.id,
        why: reading?.detail ?? `${label} answered no reading of the theme it serves`,
      }),
    ];
  }
  const served = reading.themeId;
  const when = landedWhen(landing.landedAt, 'mark');
  const moved = served !== landing.id;
  if (moved && !after(reading.publishedAt, landing.landedAt)) {
    const since = reading.publishedAt
      ? `published at ${reading.publishedAt}, which is not after ${when}`
      : 'and nothing says when it was published';
    return [
      miss(landing, 'theme', landing.id, {
        landed: `theme ${landing.id}`,
        served: `theme ${served}`,
        why: `${label} serves theme \`${served}\`, ${since}, so it cannot carry ${at}`,
      }),
    ];
  }
  const out: Judged[] = [];
  if (!landing.removed) {
    for (const file of landing.files) {
      const sum = reading.files.get(file.path);
      if (!sum) {
        out.push(
          miss(landing, 'theme', `${landing.id} ${file.path}`, {
            landed: `theme ${landing.id} ${file.path}${file.checksum ? ` @${file.checksum}` : ''}`,
            served: `theme ${served} (no such file)`,
            why: `${label} serves theme \`${served}\` with no file \`${file.path}\``,
          }),
        );
      } else if (!moved && file.checksum && !sum.startsWith(file.checksum)) {
        out.push(
          miss(landing, 'theme', `${landing.id} ${file.path}`, {
            landed: `theme ${landing.id} ${file.path} @${file.checksum}`,
            served: `theme ${served} ${file.path} @${sum}`,
            why: `${label} serves theme \`${served}\` with \`${file.path}\` at sha-256 \`${sum}\`, not the \`${file.checksum}\` the landing named`,
          }),
        );
      }
    }
  }
  if (out.length > 0) return out;
  const files =
    landing.files.length > 0 ? `, holding ${landing.files.map((f) => f.path).join(', ')}` : '';
  return [
    {
      carried: true,
      how: moved
        ? `serves theme \`${served}\`, published at ${reading.publishedAt}, after ${at} was recorded at ${landing.landedAt}${files}`
        : `serves ${at} itself${files}${landing.files.some((f) => f.checksum) ? ' at the sha-256 named' : ''}`,
    },
  ];
}

export function judgeSetting(
  landing: SettingLanding,
  reading: StorefrontSettingReading | undefined,
  label: string,
): Judged {
  const at = `setting \`${landing.key}\``;
  if (reading?.kind !== 'value') {
    return miss(landing, 'setting', landing.key, {
      landed: landing.value,
      why: reading?.detail ?? `${label} answered no reading of ${at}`,
    });
  }
  if (reading.value === landing.value) {
    return { carried: true, how: `holds ${at} = \`${reading.value}\`` };
  }
  return miss(landing, 'setting', landing.key, {
    landed: landing.value,
    served: reading.value,
    why: `${label} holds ${at} = \`${reading.value}\`, not the \`${landing.value}\` landed`,
  });
}
