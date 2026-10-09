// The sections of a release page that read straight off the release record (REQ-40): the header and
// who approved it (BC-1, BC-12), the user-facing lines as Improvements and Fixes (BC-6), what an
// admin must do (BC-7) and the developer view's technical notes (BC-9). Pure: each takes the
// `ReleaseDetail` `release-batch` reads, and says nothing the record does not hold.

import { customerNotes } from '@forge/contracts/customer-notes';
import type { ArtifactChange } from '@forge/contracts/landing-artifacts';
import { PROJECT_PERMISSIONS } from '@forge/contracts/permissions';
import type {
  ReleaseActionItem,
  ReleaseActionKind,
  ReleasePageApproval,
  ReleasePageChange,
  ReleasePageHeader,
  ReleasePageUnnoted,
  ReleaseTechnicalNotes,
} from '@forge/contracts/release-page';
import type { ReleaseDetail, ReleaseNoteSection } from '@forge/contracts/releases';
import {
  WHATS_NEW_KIND_OF_SECTION,
  WHATS_NEW_SECTIONS,
  type WhatsNewSection,
} from '@forge/contracts/whats-new';

const COMMIT = /^[0-9a-f]{40}$/;

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

/**
 * The build the page describes: the commit the release was cut at and deploys, as the release
 * record names it; none on a draft nobody cut, and none where the record holds no full commit.
 */
export function buildOf(detail: ReleaseDetail): string | null {
  if (detail.state === 'draft' || !detail.head) return null;
  return COMMIT.test(detail.head) ? detail.head : null;
}

export function headerOf(detail: ReleaseDetail): ReleasePageHeader {
  return {
    version: detail.version,
    state: detail.state,
    releasedAt: detail.releasedAt,
    environment: detail.production,
    build: buildOf(detail),
    verified: detail.verified,
    approval: approvalOf(detail),
  };
}

const isWhatsNewSection = (s: string): s is WhatsNewSection =>
  (WHATS_NEW_SECTIONS as readonly string[]).includes(s);

/**
 * Each issue's user-facing line as a customer reads it (`customer-notes.ts:customerNotes`), kept
 * with the issue it came from and the kind its section reads as. A line another already says is
 * left out; an issue whose line is held back, or that has none, is named rather than invented.
 */
export function changesOf(notes: ReleaseDetail['notes']): {
  improvements: ReleasePageChange[];
  fixes: ReleasePageChange[];
  withoutNotes: ReleasePageUnnoted[];
} {
  const view = customerNotes(notes.sections);
  const folded = new Set(view.folded.map((f) => f.key));
  const held = new Set(view.held.map((h) => h.key));
  const changes: ReleasePageChange[] = [];
  for (const section of notes.sections) {
    if (!isWhatsNewSection(section.section)) continue;
    const lines = view.sections.find((s) => s.section === section.section)?.lines ?? [];
    const keys = section.entries
      .filter((e) => !folded.has(e.key) && !held.has(e.key))
      .map((e) => e.key);
    const kind = WHATS_NEW_KIND_OF_SECTION[section.section];
    keys.forEach((issueKey, i) => {
      const line = lines[i];
      if (line) changes.push({ issueKey, kind, line });
    });
  }
  const titleOf = (key: string) =>
    notes.sections.flatMap((s) => s.entries).find((e) => e.key === key)?.title ?? key;
  return {
    improvements: changes.filter((c) => c.kind !== 'fixed'),
    fixes: changes.filter((c) => c.kind === 'fixed'),
    withoutNotes: [
      ...notes.withoutNotes.map((n) => ({
        issueKey: n.key,
        title: n.title,
        why: 'no_note' as const,
      })),
      ...view.held.map((h) => ({ issueKey: h.key, title: titleOf(h.key), why: 'held' as const })),
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

const isMigration = (a: ShippedArtifact) => a.surface === 'data' && MIGRATION.test(a.ref);
const permissionOf = (a: ShippedArtifact) => {
  const ref = a.ref.replace(/^`|`$/g, '').trim();
  return PERMISSIONS.has(ref) ? ref : null;
};

const SENTENCES: Record<ReleaseActionKind, Record<ArtifactChange, (ref: string) => string>> = {
  migration: {
    added: (ref) => `Back up the database before this release deploys: ${ref} changes its schema.`,
    changed: (ref) =>
      `Back up the database before this release deploys: ${ref} changes its schema.`,
    removed: (ref) => `Check nothing still reads what ${ref} created: this release removes it.`,
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

/** What an admin must do once the release lands, each item naming the artifact that owes it (BC-7). */
export function actionsOf(changes: ReleaseDetail['changes']): ReleaseActionItem[] {
  const out = new Map<string, ReleaseActionItem>();
  for (const a of shippedArtifacts(changes)) {
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
    const key = `${kind}:${ref}`;
    const held = out.get(key);
    if (held) {
      held.issues = [...new Set([...held.issues, ...a.issues])].sort();
      continue;
    }
    out.set(key, { kind, sentence: SENTENCES[kind][a.change](ref), ref, issues: [...a.issues] });
  }
  return [...out.values()];
}

const uniq = (refs: readonly string[]) => [...new Set(refs)].sort();

/** The developer view's addition: each issue's technical note, and the migrations, contracts and dependencies the release ships (BC-9). */
export function technicalOf(detail: ReleaseDetail): ReleaseTechnicalNotes {
  const entries = [
    ...detail.notes.sections.flatMap((s: ReleaseNoteSection) => s.entries),
    ...detail.notes.designs,
  ];
  const shipped = shippedArtifacts(detail.changes);
  return {
    notes: entries.flatMap((e) =>
      e.technical?.trim() ? [{ issueKey: e.key, title: e.title, technical: e.technical }] : [],
    ),
    migrations: uniq(shipped.filter(isMigration).map((a) => a.ref)),
    contracts: uniq(
      shipped.filter((a) => a.surface === 'api' || CONTRACT.test(a.ref)).map((a) => a.ref),
    ),
    dependencies: uniq(shipped.filter((a) => DEPENDENCY.test(a.ref)).map((a) => a.ref)),
    changes: detail.changes,
  };
}
