// The acting door (REQ-88): a project secret the project document declares for acting
// (`acting-secrets-schema.ts`) is read here by the project's master, or by a declared run working
// one of its issues, with no merge mark and no testing profile. Both call under the box's own
// credential: a run names itself (`?run=`, the id the testing door takes), and a call naming none is
// the master, which the box must hold live for the project. Who reads is settled first, then what is
// declared, then the value; each is refused by name. Every read that hands a value out is one row of
// the project's credential audit (`project_variable_events`, act `delivered`, as the variables run
// door writes), committed before the value leaves and never holding it, and the value is handed to
// the scrubber for the reading session.

import {
  ACTING_SECRET_READERS,
  type ActingSecretReader,
  type ActingSecretReaderView,
  type ActingSecretReadRecord,
  type ActingSecretReadView,
  type ActingSecretRefusalCode,
  type ActingSecretsView,
} from '@forge/contracts/acting-secrets';
import { secretRefOf } from '@forge/contracts/project-config';
import { SCRUB_MIN_SECRET_LENGTH } from '@forge/observability';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectVariableEvents } from '../db/schema-project-variables.js';
import { isVaultConfigured } from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import type { ActingSecretDeclaration } from './acting-secrets-schema.js';
import { type DeclaredRunRead, projectConfigPorts } from './ports.js';
import { readProjectSecrets } from './secret-read.js';
import { actingSecretDoor } from './secret-value-door.js';
import { credentialRefs, listTestingProfiles, readProjectConfig } from './service.js';
import { insertEvents } from './variables-store.js';

const refuse = refuser<ActingSecretRefusalCode>('ACTING_SECRET_REFUSED');

/** The reader a call is: the box's master, or a run it declared, with what the record keeps. */
interface Reader {
  kind: ActingSecretReader;
  view: ActingSecretReaderView;
  box: string;
}

const RUN_REFUSAL: Record<
  Extract<DeclaredRunRead, { kind: 'refused' }>['reason'],
  ActingSecretRefusalCode
> = {
  ended: 'ACTING_SECRET_RUN_ENDED',
  queued: 'ACTING_SECRET_RUN_NOT_ADMITTED',
  foreign: 'ACTING_SECRET_RUN_OTHER_PROJECT',
};

async function runReader(
  principal: PatPrincipal & { deviceId: string },
  projectId: string,
  asked: string,
): Promise<Reader> {
  const run = await projectConfigPorts().declaredRunOfCall(principal, asked);
  if (run.kind === 'refused') {
    throw refuse(RUN_REFUSAL[run.reason], `${run.detail} Nothing was read.`, '/run');
  }
  if (run.kind === 'none') {
    throw refuse(
      'ACTING_SECRET_RUN_NOT_RECORDED',
      `core holds no run this box declared under ${asked}. A run is recorded at core when its box opens its session; read again with the same id once it has. A run declared on another box reads under that box's credential. Nothing was read.`,
      '/run',
    );
  }
  if (run.projectId !== projectId) {
    throw refuse(
      'ACTING_SECRET_RUN_OTHER_PROJECT',
      `run ${asked} (session ${run.sessionId}) works project ${run.projectId}, not ${projectId}; a run reads only the acting secrets of the project whose issue it works. Nothing was read.`,
      '/run',
    );
  }
  if (run.issueIds.length === 0) {
    throw refuse(
      'ACTING_SECRET_RUN_NO_ISSUE',
      `run ${asked} (session ${run.sessionId}) was declared over no issue of project ${projectId}; an acting secret is read by a run working one of its issues. Nothing was read.`,
      '/run',
    );
  }
  return {
    kind: 'runs',
    view: { kind: 'run', id: run.runId, session: run.sessionId, issues: run.issueIds },
    box: principal.deviceId,
  };
}

async function masterReader(
  principal: PatPrincipal & { deviceId: string },
  projectId: string,
): Promise<Reader> {
  const fence = principal.boundProjectId
    ? [principal.boundProjectId]
    : principal.projectIds && principal.projectIds.length > 0
      ? principal.projectIds
      : null;
  const session =
    fence && !fence.includes(projectId)
      ? null
      : await projectConfigPorts().liveMasterSessionOf({ deviceId: principal.deviceId, projectId });
  if (!session) {
    throw refuse(
      'ACTING_SECRET_NOT_THE_MASTER',
      `this call names no run, so it reads as the project's master, and this box holds no live master of project ${projectId}${fence && !fence.includes(projectId) ? ` (its credential reaches ${fence.join(', ')} only)` : ''}. A declared run names itself with ?run=<its run id>. Nothing was read.`,
    );
  }
  return { kind: 'master', view: { kind: 'master', session }, box: principal.deviceId };
}

/** Who the call is: a declared run where it names one, else the box's master; a person is neither. */
async function readerOf(
  principal: PatPrincipal,
  projectId: string,
  run: string | null,
): Promise<Reader> {
  const { deviceId } = principal;
  if (!deviceId) {
    throw refuse(
      'ACTING_SECRET_READER_NOT_NAMED',
      `an acting secret is read by the project's master or a declared run, each under its box's own credential, and this credential carries no box: a person, or a token outside a box's pane, is no reader. Nothing was read.`,
    );
  }
  const boxed = { ...principal, deviceId };
  return run === null ? masterReader(boxed, projectId) : runReader(boxed, projectId, run);
}

/** The project's acting declarations; none where it declares no document or none. */
export async function actingDeclarations(projectId: string): Promise<ActingSecretDeclaration[]> {
  return (await readProjectConfig(projectId))?.document.actingSecrets ?? [];
}

/** The declaration of `ref` the reader may read, refused by name where there is none. */
async function declarationFor(
  projectId: string,
  ref: string,
  reader: Reader,
): Promise<ActingSecretDeclaration> {
  const naming = (await listTestingProfiles(projectId)).filter((p) =>
    credentialRefs(p.document).some((r) => r.ref === ref),
  );
  if (naming.length > 0) {
    throw refuse(
      'ACTING_SECRET_TESTING_PROFILE_NAMES',
      `testing profile ${naming.map((p) => `\`${p.profileId}\``).join(', ')} names ${ref}, so it judges landed work and is read only at the testing door, under that door's rule; an acting secret is one no testing profile names. Nothing was read.`,
    );
  }
  const declared = await actingDeclarations(projectId);
  const found = declared.find((d) => d.secret === ref);
  if (!found) {
    throw refuse(
      'ACTING_SECRET_NOT_DECLARED',
      `project ${projectId} declares no acting secret ${ref}; it declares ${declared.map((d) => d.secret).join(', ') || 'none'}. A project owner declares one in the project document's \`actingSecrets\` (PUT /api/projects/${projectId}/config). Nothing was read.`,
    );
  }
  if (!found.readers.includes(reader.kind)) {
    const said = reader.kind === 'master' ? "the project's master" : 'a declared run';
    throw refuse(
      'ACTING_SECRET_READER_NOT_NAMED',
      `${ref} is declared for ${found.readers.join(' and ')} to read, and this call is ${said}. Nothing was read.`,
    );
  }
  return found;
}

/** The decrypted value of `ref`, refused by name where it cannot be handed out. */
async function valueOf(projectId: string, ref: string): Promise<string> {
  if (!isVaultConfigured()) {
    throw refuse(
      'ACTING_SECRET_VAULT_NOT_CONFIGURED',
      'INTEGRATION_MASTER_KEY is not set on this core, so no secret can be decrypted; nothing was read.',
    );
  }
  const read = await readProjectSecrets(projectId, [ref]);
  if (!read.ok && read.code === 'SECRET_VALUE_MISSING') {
    throw refuse(
      'ACTING_SECRET_VALUE_MISSING',
      `${ref} is declared for acting, and this project stores no value for it; PUT /api/projects/${projectId}/secrets/<scope>/<name> first.`,
    );
  }
  if (!read.ok) {
    throw refuse(
      'ACTING_SECRET_VALUE_UNREADABLE',
      `${ref} is stored but does not decrypt under this core's INTEGRATION_MASTER_KEY; write it again.`,
    );
  }
  const value = read.values.get(ref) as string;
  if (value.length < SCRUB_MIN_SECRET_LENGTH) {
    throw refuse(
      'ACTING_SECRET_TOO_SHORT_TO_SCRUB',
      `${ref} holds a value shorter than ${SCRUB_MIN_SECRET_LENGTH} characters, which the secret scrubber does not replace, so it would reach the reader's output in plain text; store a longer one.`,
    );
  }
  return value;
}

/**
 * `GET /api/projects/:id/acting-secrets/:scope/:name[?run=<run id>]`: the value, to the reader the
 * declaration names, recorded before it leaves (see the module's doc).
 */
export async function readActingSecret(args: {
  principal: PatPrincipal;
  projectId: string;
  scope: string;
  name: string;
  run: string | null;
}): Promise<ActingSecretReadView> {
  const { principal, projectId } = args;
  const ref = secretRefOf(args.scope, args.name);
  const reader = await readerOf(principal, projectId, args.run);
  await declarationFor(projectId, ref, reader);
  const value = await valueOf(projectId, ref);
  const view = reader.view;
  await insertEvents(db, [
    {
      projectId,
      variableId: null,
      act: 'delivered',
      key: ref,
      environment: null,
      actorId: principal.userId,
      actorTokenId: principal.tokenId,
      agency: principal.agency,
      detail: {
        acting: {
          reader: reader.kind,
          box: reader.box,
          session: view.session,
          run: view.kind === 'run' ? view.id : null,
          issues: view.kind === 'run' ? view.issues : [],
        },
      },
    },
  ]);
  projectConfigPorts().rememberHandedOut(view.session, [value]);
  return { secret: ref, value, reader: view };
}

const isReader = (v: unknown): v is ActingSecretReader =>
  (ACTING_SECRET_READERS as readonly unknown[]).includes(v);

const textOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One acting read as its audit row holds it; null for a row that is no acting read. */
function recordOf(row: {
  key: string;
  actorId: string | null;
  detail: Record<string, unknown>;
  at: Date;
}): ActingSecretReadRecord | null {
  const acting = row.detail.acting as Record<string, unknown> | undefined;
  if (!acting || !isReader(acting.reader)) return null;
  return {
    secret: row.key,
    reader: acting.reader,
    actor: row.actorId,
    box: textOf(acting.box) ?? '',
    session: textOf(acting.session) ?? '',
    run: textOf(acting.run),
    issues: Array.isArray(acting.issues) ? acting.issues.filter((i) => typeof i === 'string') : [],
    at: row.at.toISOString(),
  };
}

const ACTING_READ = and(
  eq(projectVariableEvents.act, 'delivered'),
  sql`${projectVariableEvents.detail} ? 'acting'`,
);

/** `GET /api/projects/:id/acting-secrets`: each declaration with its door, and the latest reads. */
export async function readActingSecretRecord(projectId: string): Promise<ActingSecretsView> {
  const [declared, rows] = await Promise.all([
    actingDeclarations(projectId),
    db
      .select({
        key: projectVariableEvents.key,
        actorId: projectVariableEvents.actorId,
        detail: projectVariableEvents.detail,
        at: projectVariableEvents.at,
      })
      .from(projectVariableEvents)
      .where(and(eq(projectVariableEvents.projectId, projectId), ACTING_READ))
      .orderBy(desc(projectVariableEvents.at), desc(projectVariableEvents.id))
      .limit(200),
  ]);
  const reads = rows.flatMap((r) => recordOf(r) ?? []);
  return {
    declared: declared.map((d) => ({
      secret: d.secret,
      readers: d.readers,
      valueAt: actingSecretDoor(projectId, d.secret),
    })),
    reads,
    returned: reads.length,
  };
}

/**
 * The refs each session read at the acting door, by project, from the audit rows: what the scrubber
 * takes back out of what that session posts, after a restart too.
 */
export async function actingSecretRefsOfSession(
  sessionId: string,
): Promise<Array<{ projectId: string; refs: string[] }>> {
  const rows = await db
    .select({ projectId: projectVariableEvents.projectId, key: projectVariableEvents.key })
    .from(projectVariableEvents)
    .where(
      and(
        ACTING_READ,
        sql`${projectVariableEvents.detail} -> 'acting' ->> 'session' = ${sessionId}`,
      ),
    );
  const byProject = new Map<string, Set<string>>();
  for (const r of rows) {
    const refs = byProject.get(r.projectId) ?? new Set<string>();
    refs.add(r.key);
    byProject.set(r.projectId, refs);
  }
  return [...byProject].map(([projectId, refs]) => ({ projectId, refs: [...refs] }));
}
