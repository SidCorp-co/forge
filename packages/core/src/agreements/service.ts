// A project's working agreements (REQ-90, design `working-agreements` steps edit and resolve): the read
// every door answers, and the two writes. A write is judged before anything is written: a locked
// guarantee, an agreement another configuration owns, a missing name and a stale revision are each
// refused by name; the grant itself is the route's (`project.admin`).

import type {
  AgreementDetailView,
  AgreementRefusalCode,
  AgreementRestore,
  AgreementsQuery,
  AgreementsView,
  AgreementTask,
  AgreementWrite,
} from '@forge/contracts/agreements';
import { rulingDecidersOf } from '../knowledge/index.js';
import { refuser } from '../lib/refusal.js';
import { readContentLanguage, readGateChanges, readProjectGates } from '../project-config/index.js';
import { currentRevision, FORGE_AGREEMENTS, forgeAgreementOf } from './forge-defaults.js';
import { agreementsPort } from './ports.js';
import {
  CONTENT_LANGUAGE_SLUG,
  GATE_PROFILE_SLUG,
  gatesAgreement,
  languageAgreement,
  rulingAgreements,
  WHO_AGREES_PREFIX,
} from './represented.js';
import {
  type RepresentedAgreement,
  resolveAgreementDetails,
  resolveAgreements,
} from './resolve.js';
import { appendRevision, latestRevisionOf, projectRevisionsOf } from './store.js';

const refuse = refuser<AgreementRefusalCode>('AGREEMENT_REFUSED');

/** What the project writes in other configurations, read from them as they stand. */
async function representedOf(projectId: string): Promise<RepresentedAgreement[]> {
  const [gates, changes, language, deciders] = await Promise.all([
    readProjectGates(projectId),
    readGateChanges(projectId, 20),
    readContentLanguage(projectId),
    rulingDecidersOf(projectId),
  ]);
  return [
    gatesAgreement(projectId, gates, changes),
    languageAgreement(projectId, language),
    ...rulingAgreements(projectId, deciders),
  ];
}

/** The task a query names: an issue of this project, or labels and a category; null for none. */
export async function taskOf(
  projectId: string,
  query: AgreementsQuery,
): Promise<AgreementTask | null> {
  if (query.issue) {
    const issue = await agreementsPort('issueTaskOf')(query.issue);
    if (!issue || issue.projectId !== projectId) {
      throw refuse(
        'AGREEMENT_ISSUE_NOT_FOUND',
        `project ${projectId} holds no issue ${query.issue}; name an issue of this project, or the task's labels and category`,
        '/issue',
      );
    }
    return { issueId: query.issue, labels: issue.labels, category: issue.category };
  }
  if (query.labels === undefined && query.category === undefined) return null;
  const labels = (query.labels ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { issueId: null, labels, category: query.category?.trim() || null };
}

async function inputsOf(projectId: string, task: AgreementTask | null) {
  const [rows, represented] = await Promise.all([
    projectRevisionsOf(projectId),
    representedOf(projectId),
  ]);
  return { projectId, forge: FORGE_AGREEMENTS, rows, represented, task };
}

/** Every current agreement of the project, resolved for `task` (none: conditions unresolved). */
export async function readAgreements(
  projectId: string,
  task: AgreementTask | null,
): Promise<AgreementsView> {
  return resolveAgreements(await inputsOf(projectId, task));
}

/** One current agreement with its history, or refused by name where the project has none. */
export async function readAgreement(projectId: string, slug: string): Promise<AgreementDetailView> {
  const all = resolveAgreementDetails(await inputsOf(projectId, null));
  const found = all.find((a) => a.slug === slug);
  if (found) return found;
  const latest = await latestRevisionOf(projectId, slug);
  throw refuse(
    'AGREEMENT_NOT_FOUND',
    latest
      ? `the project retired its agreement \`${slug}\` at revision ${latest.revision}, so it is not current; GET /api/projects/${projectId}/agreements lists the current ones`
      : `project ${projectId} has no agreement \`${slug}\`; GET /api/projects/${projectId}/agreements lists them`,
    '/slug',
  );
}

/** The refusal of a write to an agreement another configuration owns, naming its door; else null. */
function elsewhere(projectId: string, slug: string) {
  const door =
    slug === GATE_PROFILE_SLUG
      ? `PUT /api/projects/${projectId}/gates`
      : slug === CONTENT_LANGUAGE_SLUG
        ? `PUT /api/projects/${projectId}/config (contentLanguage, keepTermsInEnglish)`
        : slug.startsWith(WHO_AGREES_PREFIX)
          ? `PUT /api/projects/${projectId}/knowledge/${slug.slice(WHO_AGREES_PREFIX.length)} (metadata.deciders)`
          : null;
  return door
    ? refuse(
        'AGREEMENT_AUTHORITY_ELSEWHERE',
        `\`${slug}\` is written in its own configuration, so the agreement reads it from there and holds no copy: change it with ${door}. Nothing was written.`,
        '/slug',
      )
    : null;
}

const locked = (name: string) =>
  refuse(
    'AGREEMENT_LOCKED',
    `${name} is a locked core guarantee: no project overrides, restores or retires it, whatever its grant. Nothing was written.`,
    '/slug',
  );

function stale(slug: string, read: number, held: number) {
  return refuse(
    'AGREEMENT_REVISION_STALE',
    `\`${slug}\` is at project revision ${held}, and this write was read at ${read}: read it again (GET) and send the revision you read. Nothing was written.`,
    '/projectRevision',
  );
}

/**
 * Overrides a Forge default, or writes the project's own agreement, as one new revision with its
 * reason and actor; the old revision is kept. An override is written over the default revision in
 * force, so writing it again re-affirms it after the default moves (clearing Conflict).
 */
export async function writeAgreement(
  projectId: string,
  slug: string,
  write: AgreementWrite,
  actorUserId: string,
): Promise<AgreementDetailView> {
  const owned = elsewhere(projectId, slug);
  if (owned) throw owned;
  const forge = forgeAgreementOf(slug);
  if (forge?.locked) throw locked(forge.name);
  if (forge && write.name !== undefined && write.name !== forge.name) {
    throw refuse(
      'AGREEMENT_NAME_OF_DEFAULT',
      `\`${slug}\` is Forge's default ${forge.name}, and an override keeps its name; drop name, or add an agreement of the project's own under a new slug. Nothing was written.`,
      '/name',
    );
  }
  const latest = await latestRevisionOf(projectId, slug);
  const addition = forge === null;
  const name = addition
    ? (write.name ?? (latest?.change === 'addition' ? latest.name : null))
    : null;
  if (addition && !name) {
    throw refuse(
      'AGREEMENT_NAME_REQUIRED',
      `\`${slug}\` is no Forge default, so this write adds an agreement of the project's own, which needs its name (3-80 characters). Nothing was written.`,
      '/name',
    );
  }
  const held = latest?.revision ?? 0;
  if (write.projectRevision !== held) throw stale(slug, write.projectRevision, held);
  const written = await appendRevision({
    projectId,
    slug,
    expected: held,
    change: addition ? 'addition' : 'override',
    name,
    rule: write.rule,
    detail: write.detail ?? null,
    condition: write.condition ?? null,
    reason: write.reason,
    baseRevision: forge ? currentRevision(forge).revision : null,
    actorUserId,
  });
  if (!written) throw stale(slug, write.projectRevision, held + 1);
  return readAgreement(projectId, slug);
}

/**
 * Restores a Forge default (the project's override no longer holds) or retires the project's own
 * agreement (it is no longer current), as one new revision; every earlier revision is kept.
 */
export async function restoreAgreement(
  projectId: string,
  slug: string,
  restore: AgreementRestore,
  actorUserId: string,
): Promise<AgreementsView> {
  const owned = elsewhere(projectId, slug);
  if (owned) throw owned;
  const forge = forgeAgreementOf(slug);
  if (forge?.locked) throw locked(forge.name);
  const latest = await latestRevisionOf(projectId, slug);
  if (!latest || latest.change === 'restore' || latest.change === 'retire') {
    throw refuse(
      'AGREEMENT_NOTHING_TO_RESTORE',
      forge
        ? `the project holds no change to ${forge.name}: it already inherits the default. Nothing was written.`
        : `project ${projectId} holds no current agreement \`${slug}\` to retire. Nothing was written.`,
      '/slug',
    );
  }
  if (restore.projectRevision !== latest.revision) {
    throw stale(slug, restore.projectRevision, latest.revision);
  }
  const written = await appendRevision({
    projectId,
    slug,
    expected: latest.revision,
    change: forge ? 'restore' : 'retire',
    name: null,
    rule: null,
    detail: null,
    condition: null,
    reason: restore.reason,
    baseRevision: null,
    actorUserId,
  });
  if (!written) throw stale(slug, restore.projectRevision, latest.revision + 1);
  return readAgreements(projectId, null);
}
