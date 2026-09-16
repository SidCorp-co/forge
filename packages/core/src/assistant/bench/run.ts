/**
 * ISS-1051 — one trial of one task against a deployment: read the baseline, open the room, send
 * the turns, read the trail after each, look the links up, grade, and in `finally` undo what the
 * trial did with a read-back for each undo. A send that throws still yields a result: the error,
 * the turns graded so far, and the cleanup as it went. ISS-1061: a turn marked `room: 'new'`
 * opens a fresh room, every room opened is deleted, and the memory notes a trial planted are
 * found by their tokens and removed, with a read-back for each.
 */

import type { BenchClient, PreferenceChange, Preferences, Project, RoomMessage } from './client.js';
import { extractIssueLinks, gradeTurn, type LinkOutcome, type PreferenceRow } from './grade.js';
import { callLines, type Judge, type JudgeResult } from './judge.js';
import type { CleanupRecord, RoomCleanup, TrialResult, TurnRecord } from './result.js';
import { FIXTURE_KEYS, fill, type Task } from './task.js';
import { type Attempt, type ChatLogRow, pairTrail } from './trail.js';

export interface TrialArgs {
  client: BenchClient;
  task: Task;
  project: Project;
  runId: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** The sidecar judge; its verdict is stored beside the grade and never read into it. */
  judge?: Judge;
  /** Hex characters for a fresh token; defaults to a UUID's first twelve. */
  randomId?: () => string;
}

interface SentTurn {
  index: number;
  roomIndex: number;
  message: string;
  delivered: string | null;
  seconds: number;
  lookups: Record<string, LinkOutcome>;
  preferenceRows: PreferenceRow[];
}

type TrailRow = ChatLogRow & { model?: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKEW_MS = 5 * 60_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const preferenceValues = (
  p: Preferences,
): { answerStyle: string; assistantInstructions: string | null } => ({
  answerStyle: p.answerStyle,
  assistantInstructions: p.assistantInstructions ?? null,
});

const freshToken = (args: TrialArgs): string =>
  `bench-${(args.randomId ?? (() => crypto.randomUUID().replace(/-/g, '').slice(0, 12)))()}`;

async function readFixtures(args: TrialArgs): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const { client, project } = args;
  for (const name of args.task.fixtures ?? []) {
    if (name === 'projectName') values.projectName = project.name;
    if (name === 'firstOpenIssue') {
      const issue = await client.firstOpenIssue(project.id);
      values.issueKey = issue.key;
      values.issueId = issue.id;
    }
    if (name === 'issueCounts') {
      const counts = await client.issueCounts(project.id);
      values.openCount = String(counts.openCount);
      values.closedCount = String(counts.closedCount);
      values.draftCount = String(counts.draftCount);
    }
    if (name === 'waitingIssue') {
      const waiting = await client.waitingIssue(project.id);
      values.needsInfoKey = waiting.key;
      values.needsInfoId = waiting.id;
    }
    if (name === 'pipelineStates')
      values.stateList = (await client.pipelineStates(project.id)).join(', ');
    if (name === 'nonce') {
      values.nonce = freshToken(args);
      values.nonce2 = freshToken(args);
      // cm:guard two tokens that collide would let a correction task pass by matching the first value; a caller's randomId that repeats is refused here rather than graded kindly
      if (values.nonce === values.nonce2) throw new Error('nonce and nonce2 came out equal');
    }
    for (const key of FIXTURE_KEYS[name]) {
      if (values[key] === undefined) throw new Error(`fixture ${name} filled no {${key}}`);
    }
  }
  return values;
}

/** The assistant text this send delivered: the newest assistant message the room did not hold before it. */
function deliveredOf(messages: RoomMessage[], seen: Set<string>): string | null {
  const fresh = messages.filter((m) => !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  const reply = [...fresh].reverse().find((m) => m.role === 'assistant');
  if (!reply || reply.silenceReason !== null) return null;
  return reply.content;
}

const gained = (before: PreferenceChange[], after: PreferenceChange[]): PreferenceRow[] => {
  const known = new Set(before.map((c) => c.id));
  return after
    .filter((c) => !known.has(c.id))
    .map((c) => ({ field: c.field, previousValue: c.previousValue, newValue: c.newValue }));
};

async function deleteRooms(args: TrialArgs, roomIds: string[]): Promise<RoomCleanup[]> {
  const now = args.now ?? (() => new Date());
  const out: RoomCleanup[] = [];
  for (const id of roomIds) {
    const row: RoomCleanup = { id, expected: 'deleted', observed: '', at: '' };
    try {
      await args.client.deleteRoom(id);
      const back = await args.client.readRoom(id);
      row.observed = back.status === 404 ? '404' : 'still readable (200)';
    } catch (err) {
      row.observed = `refused: ${errorText(err)}`;
    }
    row.at = now().toISOString();
    out.push(row);
  }
  return out;
}

/** A note is the trial's when `forge_memory_note` wrote it from one of the trial's rooms (its sourceRef is `conversation:<roomId>:<id>`) or its text carries a trial token. */
const ownedBy =
  (rooms: string[], tokens: string[]) =>
  (n: { sourceRef: string; text: string }): boolean =>
    rooms.some((r) => n.sourceRef.startsWith(`conversation:${r}:`)) ||
    tokens.some((t) => n.text.includes(t));

/**
 * Every note the trial's rooms wrote or that carries a trial token, across every page; deleted by
 * its sourceRef and listed again. Ownership is the room in the sourceRef, never "new since the
 * trial began": a note somebody else writes meanwhile is not ours to delete (codex F1).
 */
async function deleteNotes(
  args: TrialArgs,
  rooms: string[],
  tokens: string[],
): Promise<{ memories: NonNullable<CleanupRecord['memories']>; listed: boolean }> {
  // cm:why every trial, not only the memory tasks: the ten method tasks carry no token, and the notes the assistant kept for "remember my deploy window" outlived every ISS-1051 run (22 on the QA project on 2026-09-16) because the cleanup only knew the room
  const left = ownedBy(rooms, tokens);
  const projectId = args.project.id;
  let found = 0;
  let deleted = 0;
  let listed = false;
  try {
    const hits = (await args.client.listNotes(projectId)).filter(left);
    listed = true;
    found = hits.length;
    for (const ref of new Set(hits.map((h) => h.sourceRef)))
      deleted += await args.client.deleteNote(projectId, ref);
    const remaining = (await args.client.listNotes(projectId)).filter(left).length;
    return { memories: { found, deleted, remaining }, listed };
  } catch (err) {
    args.log?.(`memory cleanup refused: ${errorText(err)}`);
    // cm:guard a refusal mid-cleanup must not read as clean: what was found and not deleted is counted as remaining, and one is charged where the listing itself was refused
    return { memories: { found, deleted, remaining: Math.max(1, found - deleted) }, listed };
  }
}

async function cleanup(
  args: TrialArgs,
  roomIds: string[],
  baseline: Preferences | null,
  changesBefore: number,
  values: Record<string, string>,
): Promise<{ record: CleanupRecord; notesKept: number | null }> {
  const now = args.now ?? (() => new Date());
  // cm:why null and not the found count when the listing was refused: the record charges one remaining so the trial fails, and a grader reading `found` 0 there would call the assistant tidy (ISS-1064)
  let notesKept: number | null = null;
  const record: CleanupRecord = {
    rooms: await deleteRooms(args, roomIds),
    preferences: { expected: null, observed: null, equal: null, at: null },
    auditRowsAdded: 0,
    memories: null,
  };
  if (roomIds.length > 0) {
    const tokens = [values.nonce, values.nonce2].filter((t): t is string => Boolean(t));
    const notes = await deleteNotes(args, roomIds, tokens);
    record.memories = notes.memories;
    notesKept = notes.listed ? notes.memories.found : null;
  }
  if (baseline && args.task.preference) {
    const expected = preferenceValues(baseline);
    record.preferences.expected = expected;
    try {
      await args.client.writePreferences(expected);
      const observed = preferenceValues(await args.client.readPreferences());
      record.preferences.observed = observed;
      record.preferences.equal =
        observed.answerStyle === expected.answerStyle &&
        observed.assistantInstructions === expected.assistantInstructions;
    } catch (err) {
      record.preferences.equal = false;
      args.log?.(`preference restore refused: ${errorText(err)}`);
    }
    record.preferences.at = now().toISOString();
  }
  try {
    record.auditRowsAdded = (await args.client.preferenceChanges()).length - changesBefore;
  } catch (err) {
    args.log?.(`audit row count refused: ${errorText(err)}`);
  }
  return { record, notesKept };
}

function turnRecord(
  sent: SentTurn,
  attempts: Attempt[],
  args: TrialArgs,
  values: Record<string, string>,
  judge: JudgeResult | undefined,
  notesKept: number | null,
): TurnRecord {
  const turn = args.task.turns[sent.index];
  if (!turn) throw new Error(`task ${args.task.id} has no turn ${sent.index + 1}`);
  const grade = gradeTurn(turn, {
    delivered: sent.delivered,
    attempts,
    seconds: sent.seconds,
    budgetSeconds: args.task.budgetSeconds,
    values,
    lookups: sent.lookups,
    preferenceRows: sent.preferenceRows,
    notesKept,
  });
  return {
    index: sent.index,
    message: sent.message,
    reply: sent.delivered,
    pass: grade.pass,
    modes: grade.modes,
    evidence: grade.evidence,
    seconds: sent.seconds,
    attempts: attempts.map((a) => ({
      chatLogId: a.chatLogId,
      calls: a.calls.length,
      iterations: a.iterations,
      ms: a.ms,
      reply: a.reply,
      error: a.error,
    })),
    ...(judge ? { judge } : {}),
  };
}

/** The block the judge reads that the assistant did not: the filled fixtures, then the earlier turns of this trial. */
function referenceFor(
  values: Record<string, string>,
  sends: SentTurn[],
  upTo: number,
): string | undefined {
  const lines = Object.entries(values).map(([k, v]) => `${k}: ${v}`);
  for (const s of sends.slice(0, upTo)) {
    lines.push(`turn ${s.index + 1} asked: ${s.message}`);
    lines.push(`turn ${s.index + 1} replied: ${s.delivered ?? '(no reply)'}`);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * Every sent turn judged, after the rules have graded and the rooms are gone; or none, with the
 * refusal, when the judge is one of the models the trail names — a model must not grade itself.
 */
async function judgeTurns(
  args: TrialArgs,
  sends: SentTurn[],
  attempts: Attempt[][],
  models: string[],
  values: Record<string, string>,
): Promise<{ judged: Array<JudgeResult | undefined>; refused: string | null }> {
  const judge = args.judge;
  if (!judge) return { judged: [], refused: null };
  if (models.includes(judge.model))
    return {
      judged: [],
      refused: `judge ${judge.model} is the model under test (trail rows name ${models.join(', ')}); no turn judged`,
    };
  const judged: Array<JudgeResult | undefined> = [];
  for (const [i, sent] of sends.entries()) {
    const turnAttempts = attempts[i] ?? [];
    const reference = referenceFor(values, sends, i);
    judged[i] = await judge.judge({
      query: sent.message,
      reply: sent.delivered,
      calls: callLines(turnAttempts.flatMap((a) => a.calls)),
      error: turnAttempts.at(-1)?.error ?? null,
      ...(args.task.judgeRubric ? { rubric: args.task.judgeRubric } : {}),
      ...(reference ? { reference } : {}),
    });
  }
  return { judged, refused: null };
}

/** The attempts per sent turn, paired room by room and laid back in turn order. */
function pairRooms(
  rooms: string[],
  rows: TrailRow[],
  snapshots: string[][][],
  sends: SentTurn[],
): Attempt[][] {
  const out: Attempt[][] = sends.map(() => []);
  rooms.forEach((roomId, r) => {
    const own = sends.map((s, i) => [s, i] as const).filter(([s]) => s.roomIndex === r);
    const paired = pairTrail(roomId, rows, snapshots[r] ?? [[]]);
    own.forEach(([, sendIndex], j) => {
      out[sendIndex] = paired[j] ?? [];
    });
  });
  return out;
}

/**
 * One trial; the model the trail named travels beside the result for the file's header, and
 * `judgeRefused` names both models when the judge was the one under test.
 */
export async function runTrial(
  args: TrialArgs,
): Promise<{ result: TrialResult; model: string | null; judgeRefused: string | null }> {
  const now = args.now ?? (() => new Date());
  const started = now();
  const retriesBefore = args.client.retries();
  const dateFrom = new Date(started.getTime() - SKEW_MS).toISOString();
  const readTrail = (): Promise<TrailRow[]> =>
    args.client.trail<TrailRow>({
      projectSlug: args.project.slug,
      dateFrom,
      dateTo: new Date(now().getTime() + SKEW_MS).toISOString(),
    });

  const rooms: string[] = [];
  let baseline: Preferences | null = null;
  let changesBefore = 0;
  let error: string | null = null;
  const sends: SentTurn[] = [];
  /** One snapshot list per room: the trail ids the room held after each of its sends. */
  const snapshots: string[][][] = [];
  let rows: TrailRow[] = [];
  let values: Record<string, string> = {};

  const openRoom = async (): Promise<string> => {
    const title = `bench ${args.runId} ${args.task.id}${rooms.length > 0 ? ` room ${rooms.length + 1}` : ''}`;
    const room = await args.client.openRoom(args.project.id, title);
    rooms.push(room.id);
    snapshots.push([[]]);
    return room.id;
  };

  try {
    baseline = await args.client.readPreferences();
    changesBefore = (await args.client.preferenceChanges()).length;
    values = await readFixtures(args);
    if (args.task.preference?.setup) await args.client.writePreferences(args.task.preference.setup);
    let roomId = await openRoom();
    const seen = new Set<string>();
    for (const [index, turn] of args.task.turns.entries()) {
      if (turn.room === 'new') roomId = await openRoom();
      const roomIndex = rooms.length - 1;
      const message = fill(turn.message, values);
      const before = await args.client.preferenceChanges();
      const t0 = now().getTime();
      const sent = await args.client.send(roomId, message);
      const seconds = (now().getTime() - t0) / 1000;
      const delivered = deliveredOf(sent.messages, seen);
      rows = await readTrail();
      snapshots[roomIndex]?.push(rows.filter((r) => r.sessionId === roomId).map((r) => r.id));
      const lookups: Record<string, LinkOutcome> = {};
      for (const link of extractIssueLinks(delivered ?? '')) {
        if (UUID_RE.test(link.segment) && lookups[link.segment] === undefined)
          lookups[link.segment] = await args.client.issueExists(link.segment);
      }
      const preferenceRows = gained(before, await args.client.preferenceChanges());
      sends.push({ index, roomIndex, message, delivered, seconds, lookups, preferenceRows });
      args.log?.(`${args.task.id} turn ${index + 1}: ${seconds.toFixed(1)}s`);
    }
  } catch (err) {
    error = errorText(err);
    args.log?.(`${args.task.id} stopped: ${error}`);
  }

  const { record, notesKept } = await cleanup(args, rooms, baseline, changesBefore, values);
  const attempts = pairRooms(rooms, rows, snapshots, sends);
  const roomRows = rows.filter((r) => r.sessionId !== null && rooms.includes(r.sessionId));
  const models = [...new Set(roomRows.flatMap((r) => (r.model ? [r.model] : [])))];
  const { judged, refused } = await judgeTurns(args, sends, attempts, models, values);
  // cm:why the cleanup's count reaches every turn's grade: the notes a trial kept are known only after the rooms are read back, and a check on the last turn is where a task bounds them (ISS-1064)
  const turns = sends.map((sent, i) =>
    turnRecord(sent, attempts[i] ?? [], args, values, judged[i], notesKept),
  );
  const undeleted = record.rooms.some((r) => r.observed !== '404');
  const leftover = (record.memories?.remaining ?? 0) > 0;
  return {
    model: models[0] ?? null,
    judgeRefused: refused,
    result: {
      at: started.toISOString(),
      retried: args.client.retries() - retriesBefore,
      // cm:guard a trial whose room or notes outlived the cleanup is not a pass: the next reading of the project would carry them
      pass:
        error === null &&
        turns.length === args.task.turns.length &&
        turns.every((t) => t.pass) &&
        !undeleted &&
        !leftover,
      error,
      seconds: turns.reduce((sum, t) => sum + t.seconds, 0),
      turns,
      cleanup: record,
    },
  };
}
