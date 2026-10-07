// A release whose work lives on a storefront is proved by what the provider serves, never by a
// commit: a storefront keeps no deployment record and no commit. Each claimed issue is proved
// through what it landed (`provider-landings.ts`) — the storefront draft its verdicts judged, and
// every workflow, route, page, theme and setting its mark names — read against what production's
// provider serves now (`provider-judge.ts`); an issue whose mark is only a design approval, through
// that approval's record. Anything else is `RELEASE_NOT_VERIFIED`, naming the issue, the thing it
// landed and both identities.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  getIntegration,
  readStorefrontPublished,
  type StorefrontServed,
} from '../integrations/index.js';
import type { ReleaseChannel } from './plan.js';
import {
  type Judged,
  judgePage,
  judgeRoute,
  judgeSetting,
  judgeTheme,
  judgeWorkflow,
} from './provider-judge.js';
import {
  type DesignLanding,
  type Landings,
  landingsOf,
  type ProviderMismatch,
} from './provider-landings.js';
import { readDesignApprovals, readProviderRoster } from './provider-roster.js';

export type { ProviderMismatch } from './provider-landings.js';

export type ProviderOutcome =
  | { ok: true; identity: string; readings: string[] }
  | { ok: false; reason: string; mismatches: ProviderMismatch[] };

/** One sentence per mismatch, naming the issue, what it landed and both identities. */
export function mismatchSentence(m: ProviderMismatch): string {
  switch (m.kind) {
    case 'workflow': {
      const code = m.workflowCode ? ` (\`${m.workflowCode}\`)` : '';
      const at = m.landed ? ` at draft \`${m.landed}\`` : '';
      return `${m.issue} landed workflow \`${m.workflow}\`${code}${at}, and ${m.why}`;
    }
    case 'theme':
      return `${m.issue} landed ${m.landed ?? `theme ${m.ref}`}, and ${m.why}`;
    case 'setting':
      return `${m.issue} landed setting \`${m.ref}\` = \`${m.landed}\`, and ${m.why}`;
    case 'route':
    case 'page':
    case 'design':
      return `${m.issue} landed ${m.kind} \`${m.ref}\`, and ${m.why}`;
    default:
      return m.why;
  }
}

/** Each design-only issue against the approval record of every revision its mark names. */
function judgeDesign(
  landing: DesignLanding,
  approvals: ReadonlyMap<string, string>,
  label: string,
): Judged {
  const missing = landing.refs.filter((r) => !approvals.has(r));
  if (missing.length > 0) {
    return {
      carried: false,
      mismatch: {
        issue: landing.issue,
        kind: 'design',
        ref: missing.join(', '),
        workflow: null,
        workflowCode: null,
        landed: missing.join(', '),
        served: null,
        why: `no approval of ${missing.map((r) => `\`${r}\``).join(', ')} is recorded in this project, and a design deploys nothing ${label} could show instead`,
      },
    };
  }
  const approved = landing.refs.map((r) => `${r} (approved ${approvals.get(r)})`).join(', ');
  const commits =
    landing.judgedCommits.length > 0
      ? `; its verdicts judged commit ${landing.judgedCommits.map((c) => c.slice(0, 12)).join(', ')}, and its mark names nothing that commit shipped, so none of it is attested here`
      : '';
  return {
    carried: true,
    how: `its landing is the approval of design ${approved}, which deploys nothing ${label} serves${commits}`,
  };
}

/** Every landing against what the provider serves; green only where every one is carried. */
export function judgeProviderRecord(
  found: Landings,
  served: StorefrontServed,
  approvals: ReadonlyMap<string, string>,
  label: string,
): ProviderOutcome {
  const mismatches = [...found.unprovable];
  const lines: string[] = [];
  const take = (issue: string, ref: string, judged: Judged) => {
    if (judged.carried) lines.push(`${issue}: ${ref} — ${label} ${judged.how}`);
    else mismatches.push(judged.mismatch);
  };
  for (const w of found.workflows) {
    take(w.issue, w.ref, judgeWorkflow(w, served.workflows.get(w.workflowId), label));
  }
  for (const r of found.routes) take(r.issue, r.ref, judgeRoute(r, served.routes.get(r.id), label));
  for (const p of found.pages) take(p.issue, p.ref, judgePage(p, served.pages.get(p.id), label));
  for (const t of found.themes) {
    for (const judged of judgeTheme(t, served.theme, label)) take(t.issue, t.ref, judged);
  }
  for (const s of found.settings) {
    take(s.issue, s.ref, judgeSetting(s, served.settings.get(s.key), label));
  }
  for (const d of found.design) {
    const judged = judgeDesign(d, approvals, label);
    if (judged.carried) lines.push(`${d.issue}: ${judged.how}`);
    else mismatches.push(judged.mismatch);
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: `what ${label} serves does not carry ${mismatches.length} landing(s) of this release: ${mismatches.map(mismatchSentence).join('; ')}`,
      mismatches,
    };
  }
  const read =
    found.workflows.length + found.routes.length + found.pages.length + found.themes.length;
  if (read + found.settings.length === 0) {
    return {
      ok: false,
      reason: `no issue of this release landed anything ${label} serves, so nothing it carries can be checked against what ${label} serves`,
      mismatches: [],
    };
  }
  for (const u of found.unattested) {
    lines.push(
      `${u.issue}: ${u.ref} — ${label} reports no state for this, so it is not attested here`,
    );
  }
  const identity: string[] = [];
  for (const [id, r] of served.workflows) {
    if (r.kind === 'published') identity.push(`${id}@${r.graphVersion}`);
  }
  identity.sort();
  if (served.theme?.kind === 'served') identity.push(`theme ${served.theme.themeId}`);
  return { ok: true, identity: identity.join(', '), readings: lines };
}

/** The issues a batch run still claims: the roster its finish closes. */
export async function rosterOfRun(runId: string): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));
  return rows.map((r) => r.id);
}

/**
 * Whether what production's storefront provider serves, read once, now, carries every landing of
 * these issues.
 */
export async function verifyByProviderRecord(args: {
  projectId: string;
  issueIds: readonly string[];
  channel: ReleaseChannel;
}): Promise<ProviderOutcome> {
  const { projectId, channel } = args;
  const label = getIntegration(channel.provider)?.presentation?.label ?? channel.provider;
  if (args.issueIds.length === 0) {
    return {
      ok: false,
      reason: `this release claims no issue, so nothing it carries can be checked against what ${label} serves`,
      mismatches: [],
    };
  }
  const found = landingsOf(await readProviderRoster(projectId, args.issueIds), label);
  const ask = {
    workflowIds: found.workflows.map((w) => w.workflowId),
    routeIds: found.routes.map((r) => r.id),
    pageIds: found.pages.map((p) => p.id),
    theme: found.themes.length > 0,
    settingKeys: found.settings.map((s) => s.key),
  };
  const asking =
    ask.workflowIds.length + ask.routeIds.length + ask.pageIds.length + ask.settingKeys.length >
      0 || ask.theme;
  const [served, approvals] = await Promise.all([
    asking
      ? readStorefrontPublished({ provider: channel.provider, binding: channel.bindingId, ask })
      : Promise.resolve<StorefrontServed>({
          workflows: new Map(),
          routes: new Map(),
          pages: new Map(),
          theme: null,
          settings: new Map(),
        }),
    readDesignApprovals(
      projectId,
      found.design.flatMap((d) => d.refs),
    ),
  ]);
  return judgeProviderRecord(found, served, approvals, label);
}
