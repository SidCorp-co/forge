// The sections of a release page that read straight off the release record (REQ-40): the header and
// who approved it (BC-1, BC-12), the user-facing lines as Improvements and Fixes (BC-6), what an
// admin must do (BC-7) and the developer view's technical notes (BC-9). Pure: each takes the
// `ReleaseDetail` `release-batch` reads, and says nothing the record does not hold.

import { customerNotes } from '@forge/contracts/customer-notes';
import type { ArtifactChange } from '@forge/contracts/landing-artifacts';
import { PROJECT_PERMISSIONS } from '@forge/contracts/permissions';
import {
  type ReleaseActionItem,
  type ReleaseActionKind,
  type ReleasePageApproval,
  type ReleasePageChange,
  type ReleasePageHeader,
  type ReleasePageInternal,
  type ReleasePageInternals,
  type ReleasePageUnnoted,
  type ReleasePageViewKind,
  type ReleaseShipped,
  type ReleaseTechnicalNotes,
  releaseBuildOf,
  releaseEnded,
} from '@forge/contracts/release-page';
import {
  type ReleaseDetail,
  type ReleaseNoteSection,
  releaseVerifiedLevel,
} from '@forge/contracts/releases';
import {
  WHATS_NEW_KIND_OF_SECTION,
  WHATS_NEW_SECTIONS,
  type WhatsNewSection,
} from '@forge/contracts/whats-new';
import {
  isMigratorBookkeeping,
  type RangeReading,
  rangeChangesOf,
  type SurfaceMap,
} from '../release-batch/index.js';

/** Who approved it, or that nobody was asked: an approval given anyway still shows (BC-12). */
export function approvalOf(detail: ReleaseDetail): ReleasePageApproval {
  const required = detail.approvalRequired;
  const asked = detail.approval;
  if (asked?.decision && asked.decidedBy) {
    return { required, state: asked.decision, by: asked.decidedBy, at: asked.decidedAt };
  }
  if (asked) return { required, state: 'pending', by: null, at: null };
  const owed = required && detail.state !== 'shipped';
  return { required, state: owed ? 'pending' : 'not_asked', by: null, at: null };
}

/** The build the page describes, the one the release record counts its criteria on (`releaseBuildOf`). */
export function buildOf(detail: ReleaseDetail): string | null {
  return releaseBuildOf(detail.state, detail.head);
}

/**
 * The page's header. Its proven count is the page's own (`claims.ts:readClaims`, the rule a
 * requirement counts by), so the header, the list and the totals read one number; the release
 * record's deploy check is kept as it stands.
 */
export function headerOf(
  detail: ReleaseDetail,
  counted: { proven: number; total: number },
): ReleasePageHeader {
  return {
    version: detail.version,
    name: detail.name,
    summary: detail.summary,
    state: detail.state,
    releasedAt: detail.releasedAt,
    environment: detail.production,
    build: buildOf(detail),
    verified: {
      ...detail.verified,
      ...counted,
      level: releaseVerifiedLevel(counted, detail.verified.check),
    },
    approval: approvalOf(detail),
  };
}

const isWhatsNewSection = (s: string): s is WhatsNewSection =>
  (WHATS_NEW_SECTIONS as readonly string[]).includes(s);

/**
 * Each change as users read it (`customer-notes.ts:customerNotes`): its short title and the sentence
 * that says it in full, whole (REQ-40 BC-6), kept with the issue it came from, the requirement that
 * issue traces and the kind its section reads as. A line another already says is left out; an issue
 * whose line is held back, that has none, whose note still owes a short title or one sentence on a
 * release still to ship (REQ-70 BC-3), or whose line now says a later round (`notes.reworked`), is
 * named rather than invented. A release that ended reads its notes as they were when it ended. What nobody using the product sees — a `Skip` note, or an issue
 * that only carries another change out — is counted apart and listed on the developer view only
 * (REQ-40 BC-16).
 */
export function changesOf(
  detail: Pick<ReleaseDetail, 'notes' | 'issues' | 'state'>,
  view: ReleasePageViewKind,
): {
  improvements: ReleasePageChange[];
  fixes: ReleasePageChange[];
  internal: ReleasePageInternals;
  withoutNotes: ReleasePageUnnoted[];
} {
  const { notes } = detail;
  const notesView = customerNotes(notes.sections, { ended: releaseEnded(detail.state) });
  const requirementOf = new Map(detail.issues.map((i) => [i.key, i.requirement]));
  const changes: ReleasePageChange[] = [];
  for (const section of notesView.sections) {
    if (!isWhatsNewSection(section.section)) continue;
    const named = section.section;
    const kind = WHATS_NEW_KIND_OF_SECTION[named];
    for (const l of section.lines) {
      changes.push({
        issueKey: l.key,
        kind,
        section: named,
        line: l.line,
        detail: l.detail,
        requirementKey: requirementOf.get(l.key) ?? null,
      });
    }
  }
  const titleOf = (key: string) =>
    notes.sections.flatMap((s) => s.entries).find((e) => e.key === key)?.title ?? key;
  const internal: ReleasePageInternal[] = [
    ...notes.skipped.map((n) => ({ issueKey: n.key, title: n.title, why: 'skip' as const })),
    ...notesView.folded
      .filter((f) => f.why === 'carries')
      .map((f) => ({ issueKey: f.key, title: titleOf(f.key), why: 'carries' as const })),
  ];
  return {
    improvements: changes.filter((c) => c.kind !== 'fixed'),
    fixes: changes.filter((c) => c.kind === 'fixed'),
    internal: {
      count: internal.length,
      changes: view === 'developer' ? internal : null,
    },
    withoutNotes: [
      ...notes.withoutNotes.map((n) => ({
        issueKey: n.key,
        title: n.title,
        why: 'no_note' as const,
      })),
      ...notesView.held.map((h) => ({
        issueKey: h.key,
        title: titleOf(h.key),
        why: 'held' as const,
      })),
      ...notesView.unwritten.map((u) => ({ issueKey: u.key, title: titleOf(u.key), why: u.why })),
      ...notes.reworked.map((n) => ({
        issueKey: n.key,
        title: n.title,
        why: 'reworked' as const,
      })),
    ],
  };
}

interface ShippedArtifact {
  ref: string;
  change: ArtifactChange;
  issues: string[];
  surface: string;
}

/** Every artifact this release itself ships: one another issue's release carries is that release's to act on. */
function shippedArtifacts(changes: ReleaseDetail['changes']): ShippedArtifact[] {
  return changes.surfaces.flatMap((s) =>
    s.artifacts
      .filter((a) => a.carriedBy === null)
      .map((a) => ({ ref: a.ref, change: a.change, issues: a.issues, surface: s.surface })),
  );
}

const MIGRATION = /(^|\/)migrations?\/|\.sql$/i;
const DEPENDENCY =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements\.txt|pyproject\.toml)$/;
const CONTRACT = /(^|\/)contracts?\//;
const PERMISSIONS: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS);

const isMigration = (a: ShippedArtifact) =>
  a.surface === 'data' && MIGRATION.test(a.ref) && !isMigratorBookkeeping(a.ref);
const permissionOf = (a: ShippedArtifact) => {
  const ref = a.ref.replace(/^`|`$/g, '').trim();
  return PERMISSIONS.has(ref) ? ref : null;
};

const SENTENCES: Record<ReleaseActionKind, Record<ArtifactChange, (ref: string) => string>> = {
  // said without the file: the overview names no path (REQ-40 BC-15); `ref` keeps it for the developer view
  migration: {
    added: () => 'Back up the database before this release deploys: it changes the schema.',
    changed: () => 'Back up the database before this release deploys: it changes the schema.',
    removed: () => 'Check nothing still reads the tables this release removes.',
  },
  step: {
    added: (sentence) => sentence,
    changed: (sentence) => sentence,
    removed: (sentence) => sentence,
  },
  permission: {
    added: (ref) => `Grant ${ref} to the people who should have it: it is new in this release.`,
    changed: (ref) => `Review who holds ${ref}: what it allows changes in this release.`,
    removed: (ref) => `Check nobody relies on ${ref}: this release removes it.`,
  },
  setting: {
    added: (ref) => `Set ${ref} where this project needs it: it is new in this release.`,
    changed: (ref) => `Check ${ref}: its meaning or default changes in this release.`,
    removed: (ref) => `Remove ${ref} from your configuration: this release no longer reads it.`,
  },
};

/** What the range ships as artifacts: the migrations it adds and the settings a deployment now refuses to start without. */
function derivedArtifacts(shipped: ReleaseShipped): ShippedArtifact[] {
  if (shipped.state !== 'read') return [];
  return [
    ...shipped.migrations.map((ref) => ({
      ref,
      change: 'added' as const,
      issues: [],
      surface: 'data',
    })),
    ...shipped.settings
      .filter((s) => s.required)
      .map((s) => ({ ref: s.name, change: 'added' as const, issues: [], surface: 'config' })),
  ];
}

/**
 * What the issues' landings add to a page. Where the range is read it is what the release ships: a
 * landing only names the issues behind an item the range ships, or a permission key, which no range
 * reads. An issue carried again (reopened, then released anew) still names all it ever landed,
 * which an earlier release shipped. Where the range is unread, every landing counts, as it says.
 */
function landedArtifacts(
  changes: ReleaseDetail['changes'],
  shipped: ReleaseShipped,
): ShippedArtifact[] {
  const landed = shippedArtifacts(changes);
  if (shipped.state !== 'read') return landed;
  const ships = new Set(shipped.migrations);
  return landed.filter((a) => permissionOf(a) !== null || (isMigration(a) && ships.has(a.ref)));
}

/** Every admin step the release's notes name, one item per sentence, with each issue that names it. */
function writtenSteps(notes: ReleaseDetail['notes']): ReleaseActionItem[] {
  const out = new Map<string, ReleaseActionItem>();
  const entries = [...notes.sections.flatMap((s) => s.entries), ...notes.skipped, ...notes.designs];
  for (const e of entries) {
    for (const step of e.adminSteps) {
      const held = out.get(step);
      if (held) held.issues = [...new Set([...held.issues, e.key])].sort(byKey);
      else out.set(step, { kind: 'step', sentence: step, ref: null, issues: [e.key] });
    }
  }
  return [...out.values()];
}

const byKey = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * What an admin must do before or as the release lands (BC-7): the steps its issues' notes name,
 * then what its commit range ships (`shipped`) and what its issues' landings add
 * (`landedArtifacts`), each derived item naming the artifact that owes it and said once.
 */
export function actionsOf(
  changes: ReleaseDetail['changes'],
  shipped: ReleaseShipped,
  notes: ReleaseDetail['notes'],
): ReleaseActionItem[] {
  const out = new Map<string, ReleaseActionItem>();
  for (const a of [...derivedArtifacts(shipped), ...landedArtifacts(changes, shipped)]) {
    const permission = permissionOf(a);
    const kind: ReleaseActionKind | null = permission
      ? 'permission'
      : isMigration(a)
        ? 'migration'
        : a.surface === 'config'
          ? 'setting'
          : null;
    if (!kind) continue;
    const ref = permission ?? a.ref;
    const sentence = SENTENCES[kind][a.change](ref);
    // migrations are said once per sentence, every file they name kept in `ref`
    const key = kind === 'migration' ? `${kind}:${sentence}` : `${kind}:${ref}`;
    const held = out.get(key);
    if (held) {
      held.issues = [...new Set([...held.issues, ...a.issues])].sort();
      if (held.ref !== null && !held.ref.split(', ').includes(ref))
        held.ref = `${held.ref}, ${ref}`;
      continue;
    }
    out.set(key, { kind, sentence, ref, issues: [...a.issues] });
  }
  return [...writtenSteps(notes), ...out.values()];
}

const uniq = (refs: readonly string[]) => [...new Set(refs)].sort();

const KEPT_WITHOUT_FILES =
  'the range was kept before its changed files were: report it again to list them';

/**
 * What the release changes, as the developer view says it: where the range is read, the range's own
 * files (`rangeChangesOf`), never a landing's other paths, which another release shipped; where it
 * was kept without its files, that, and nothing guessed in their place; where it is unread, what the
 * issues' landings name, as they say.
 */
function changesOfRange(
  detail: ReleaseDetail,
  range: RangeReading,
  map: SurfaceMap | null,
): ReleaseDetail['changes'] {
  if (range.shipped.state !== 'read') return detail.changes;
  if (range.changed) return rangeChangesOf(range.changed, map, detail.changes);
  return {
    surfaces: [],
    risks: [],
    unclassified: [{ key: null, why: KEPT_WITHOUT_FILES, paths: [] }],
    boxRead: [],
    shipsNothing: false,
  };
}

/**
 * The developer view's addition: each issue's technical note, and what the release changes and the
 * migrations, contracts and dependencies it ships (BC-9) — the range's own, where it is read and named
 * above them; what the issues' landings name only where it is unread.
 */
export function technicalOf(
  detail: ReleaseDetail,
  range: RangeReading,
  map: SurfaceMap | null,
): ReleaseTechnicalNotes {
  const entries = [
    ...detail.notes.sections.flatMap((s: ReleaseNoteSection) => s.entries),
    ...detail.notes.designs,
  ];
  const notes = entries.flatMap((e) =>
    e.technical?.trim() ? [{ issueKey: e.key, title: e.title, technical: e.technical }] : [],
  );
  const changes = changesOfRange(detail, range, map);
  const { shipped } = range;
  if (shipped.state === 'read') {
    return {
      notes,
      migrations: uniq(shipped.migrations),
      contracts: uniq(shipped.contracts),
      dependencies: uniq(shipped.dependencies),
      settings: uniq(
        shipped.settings.map((s) => `${s.name} (${s.required ? 'required' : 'optional'})`),
      ),
      changes,
    };
  }
  const landed = shippedArtifacts(detail.changes);
  return {
    notes,
    migrations: uniq(landed.filter(isMigration).map((a) => a.ref)),
    contracts: uniq(
      landed.filter((a) => a.surface === 'api' || CONTRACT.test(a.ref)).map((a) => a.ref),
    ),
    dependencies: uniq(landed.filter((a) => DEPENDENCY.test(a.ref)).map((a) => a.ref)),
    settings: [],
    changes,
  };
}
