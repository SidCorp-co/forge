/**
 * ISS-1051 — one trial of one task against a deployment: read the baseline, open the room, send
 * the turns, read the trail after each, look the links up, grade, and in `finally` undo what the
 * trial did with a read-back for each undo. A send that throws still yields a result: the error,
 * the turns graded so far, and the cleanup as it went.
 */

import type { BenchClient, PreferenceChange, Preferences, Project, RoomMessage } from './client.js';
import { extractIssueLinks, gradeTurn, type LinkOutcome, type PreferenceRow } from './grade.js';
import type { CleanupRecord, TrialResult, TurnRecord } from './result.js';
import { FIXTURE_KEYS, fill, type Task } from './task.js';
import { type Attempt, type ChatLogRow, pairTrail } from './trail.js';

export interface TrialArgs {
  client: BenchClient;
  task: Task;
  project: Project;
  runId: string;
  now?: () => Date;
  log?: (line: string) => void;
}

interface SentTurn {
  index: number;
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

async function readFixtures(args: TrialArgs): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of args.task.fixtures ?? []) {
    if (name === 'projectName') values.projectName = args.project.name;
    if (name === 'firstOpenIssue') {
      const issue = await args.client.firstOpenIssue(args.project.id);
      values.issueKey = issue.key;
      values.issueId = issue.id;
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

async function cleanup(
  args: TrialArgs,
  roomId: string | null,
  baseline: Preferences | null,
  changesBefore: number,
): Promise<CleanupRecord> {
  const now = args.now ?? (() => new Date());
  const record: CleanupRecord = {
    room: {
      id: roomId ?? '',
      expected: 'deleted',
      observed: 'never opened',
      at: now().toISOString(),
    },
    preferences: { expected: null, observed: null, equal: null, at: null },
    auditRowsAdded: 0,
  };
  if (roomId) {
    try {
      await args.client.deleteRoom(roomId);
      const back = await args.client.readRoom(roomId);
      record.room.observed = back.status === 404 ? '404' : 'still readable (200)';
    } catch (err) {
      record.room.observed = `refused: ${errorText(err)}`;
    }
    record.room.at = now().toISOString();
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
  return record;
}

function turnRecord(
  sent: SentTurn,
  attempts: Attempt[],
  args: TrialArgs,
  values: Record<string, string>,
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
  };
}

/** One trial; the model the trail named travels beside the result for the file's header. */
export async function runTrial(
  args: TrialArgs,
): Promise<{ result: TrialResult; model: string | null }> {
  const now = args.now ?? (() => new Date());
  const started = now();
  const dateFrom = new Date(started.getTime() - SKEW_MS).toISOString();
  const readTrail = (): Promise<TrailRow[]> =>
    args.client.trail<TrailRow>({
      projectSlug: args.project.slug,
      dateFrom,
      dateTo: new Date(now().getTime() + SKEW_MS).toISOString(),
    });

  let roomId: string | null = null;
  let baseline: Preferences | null = null;
  let changesBefore = 0;
  let error: string | null = null;
  const sends: SentTurn[] = [];
  const snapshots: string[][] = [];
  let rows: TrailRow[] = [];
  let values: Record<string, string> = {};

  try {
    baseline = await args.client.readPreferences();
    changesBefore = (await args.client.preferenceChanges()).length;
    values = await readFixtures(args);
    if (args.task.preference?.setup) await args.client.writePreferences(args.task.preference.setup);
    const room = await args.client.openRoom(args.project.id, `bench ${args.runId} ${args.task.id}`);
    roomId = room.id;
    snapshots.push([]);
    const seen = new Set<string>();
    for (const [index, turn] of args.task.turns.entries()) {
      const message = fill(turn.message, values);
      const before = await args.client.preferenceChanges();
      const t0 = now().getTime();
      const sent = await args.client.send(roomId, message);
      const seconds = (now().getTime() - t0) / 1000;
      const delivered = deliveredOf(sent.messages, seen);
      rows = await readTrail();
      snapshots.push(rows.filter((r) => r.sessionId === roomId).map((r) => r.id));
      const lookups: Record<string, LinkOutcome> = {};
      for (const link of extractIssueLinks(delivered ?? '')) {
        if (UUID_RE.test(link.segment) && lookups[link.segment] === undefined)
          lookups[link.segment] = await args.client.issueExists(link.segment);
      }
      const preferenceRows = gained(before, await args.client.preferenceChanges());
      sends.push({ index, message, delivered, seconds, lookups, preferenceRows });
      args.log?.(`${args.task.id} turn ${index + 1}: ${seconds.toFixed(1)}s`);
    }
  } catch (err) {
    error = errorText(err);
    args.log?.(`${args.task.id} stopped: ${error}`);
  }

  const record = await cleanup(args, roomId, baseline, changesBefore);
  const attempts = roomId ? pairTrail(roomId, rows, snapshots) : [];
  const turns = sends.map((sent, i) => turnRecord(sent, attempts[i] ?? [], args, values));
  const model = rows.find((r) => r.sessionId === roomId && r.model)?.model ?? null;
  return {
    model,
    result: {
      at: started.toISOString(),
      pass: error === null && turns.length === args.task.turns.length && turns.every((t) => t.pass),
      error,
      seconds: turns.reduce((sum, t) => sum + t.seconds, 0),
      turns,
      cleanup: record,
    },
  };
}
