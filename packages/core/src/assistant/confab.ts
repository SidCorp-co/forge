/**
 * Does the reply claim a write this turn's own tool results refused?
 *
 * Measured on `/api/chat` 2026-09-04: `forge_issues action=update` was refused
 * for naming a dispatching status, and the reply said "ISS-2 has been set to
 * open" over a row still at `draft`. The refusal reached the model as an
 * ordinary `role:'tool'` message and nothing compared it to what was said next.
 *
 * Pure and deterministic — final text and the audited records in, a verdict
 * out. `chat_logs` already stores both halves, so a stored turn is re-judgeable
 * without replaying it, which is what makes the log-only window measurable.
 */

import type { ToolCallRecord } from './run-turn-core.js';

/** A display ref as the model writes one, in the arguments and in the prose. */
const SUBJECT_RE = /\b([A-Z][A-Z0-9]*-\d+)\b/gu;

/** `action` values that change a row. A refused read is not a claim about state. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set(['create', 'update', 'mark', 'unmark']);

// cm:guard English and Vietnamese together, because the door with live traffic answers in Vietnamese. The instruction is no longer in `rocketChatPersona` — ISS-1007 moved it to each project's `agentConfig.personaStyle`, which `buildSystemPrompt` appends — so the language is now per-project and there is no persona line to read it off. An English-only matcher would report ~0 on Rocket.Chat and read as "the defect is rare" when it had only gone unread (ISS-1008).
const LANDED_RE =
  /\b(?:has|have|was|were|is|are)\s+(?:now\s+)?(?:been\s+)?(?:set|updated?|created?|moved?|changed?|marked?|closed?|opened?|filed?)\b|\bi(?:'ve|\s+have)?\s+(?:set|updated?|created?|moved?|marked?|changed?|closed?|filed?)\b|\b(?:successfully|done)\b/iu;

// cm:guard a BOUNDED list of denial constructions, read BEFORE the landed match, never negation in general which no regex closes over: `successfully` and `done` are bare vocabulary in LANDED_RE, so "ISS-2 was not updated successfully" would report the one reply shape that proves the model got it right. An unmatched construction costs one line in a log nothing acts on automatically, so the list grows from replies seen (ISS-1008).
const DENIED_RE =
  /\b(?:not|never|cannot|unable|fail(?:ed|s|ure)?|refus(?:ed|es|al)|reject(?:ed|s)?|declin(?:ed|es))\b|\bno\s+(?:way|longer)\b|n['\u2019]t\b/iu;

/** The same withdrawal in the language the Rocket.Chat door answers in; written without `\b`, which is ASCII-only in JS and would not close on a diacritic. */
// cm:ignore CM001 — the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only.
const DENIED_VI_RE = /không|chưa|thất\s*bại|từ\s*chối/iu; // i18n-allow: the phrases this matches are the ones that door's own replies are written in

// cm:guard COMPLETED forms only, never the bare infinitive: "ISS-1 has been updated to describe how to create a dashboard" satisfies the landed match, and a `creat(e|ed)` pattern here would report a creation nobody claimed. A quiet probe is the whole justification for logging rather than refusing (ISS-1008).
const CREATED_RE = /\b(?:created|filed|raised|logged|opened)\b/iu;

// cm:ignore CM001 — the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only.
const CREATED_VI_RE = /đã\s+(?:được\s+)?tạo/iu; // i18n-allow: the phrases this matches are the ones that door's own replies are written in

/** The same claim in the language the Rocket.Chat door answers in: a past-completion marker plus a write verb. */
// cm:ignore CM001 — the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only, so moving it off makes the language gate red instead.
const LANDED_VI_RE = /đã\s+(?:được\s+)?(?:tạo|cập\s*nhật|chuyển|đặt|đổi|mở|đóng|ghi|sửa)/iu; // i18n-allow: the phrases this matches are the ones that door's own replies are written in

/** One claim in the reply that a refused call this turn contradicts. */
export interface ConfabClaim {
  /** The refused call's tool name, as the model called it. */
  tool: string;
  /** The ref the refused call targeted AND the sentence named; null for a refused create, which targets no row yet — including when the sentence invents one. */
  subject: string | null;
  /** The sentence carrying the claim, trimmed. */
  sentence: string;
}

export interface ConfabProbe {
  suspected: boolean;
  claims: ConfabClaim[];
}

const NOTHING: ConfabProbe = { suspected: false, claims: [] };

/** The `forge` CLI verbs that change a row, read as the `action` the wrapper tools used to carry: `new` creates, and every other write below targets the ref its own argument names. A verb with a body path (`-`) is a write; the same verb without one is the thread read. */
// cm:guard the CLI is read as a WRITE by its verb and arguments, never by its exit code or its output: `forge issue ISS-2 --set status=open` and `forge comment ISS-2 -` are the writes chat can make, `forge issue ISS-2` and `forge issue --search q` are reads whose refusal claims nothing about a row. Measured 2026-09-15: with `forge` offered and this probe reading `action` alone, every refused CLI write audited as a read and the probe was blind to the one tracker door chat has (ISS-1009).
const CLI_TOOL = 'forge';
const CLI_SET_FLAGS: ReadonlySet<string> = new Set(['--set', '--blocks', '--relates', '--unlink']);

function cliArgvOf(record: ToolCallRecord): string[] | null {
  if (record.name !== CLI_TOOL) return null;
  try {
    const parsed = JSON.parse(record.arguments || '{}') as { argv?: unknown };
    return Array.isArray(parsed.argv) && parsed.argv.every((a) => typeof a === 'string')
      ? (parsed.argv as string[])
      : null;
  } catch {
    return null;
  }
}

function cliWriteOf(argv: readonly string[]): { action: string; target: string | null } | null {
  const [verb] = argv;
  const firstRef = argv.slice(1).flatMap((a) => refsIn(a))[0] ?? null;
  if (verb === 'new') return { action: 'create', target: null };
  if (verb === 'comment' && argv.includes('-')) return { action: 'update', target: firstRef };
  if (verb === 'issue' && argv.some((a) => CLI_SET_FLAGS.has(a)))
    return { action: 'update', target: firstRef };
  if (verb === 'attach' || verb === 'advance' || verb === 'claim' || verb === 'record')
    return { action: 'update', target: firstRef };
  return null;
}

function actionOf(record: ToolCallRecord): string | null {
  const argv = cliArgvOf(record);
  if (argv) return cliWriteOf(argv)?.action ?? null;
  try {
    const parsed = JSON.parse(record.arguments || '{}') as { action?: unknown };
    return typeof parsed.action === 'string' ? parsed.action : null;
  } catch {
    return null;
  }
}

/** Every display ref named anywhere in a string — right for a sentence, wrong for a call's arguments. */
function refsIn(text: string): string[] {
  return [...text.matchAll(SUBJECT_RE)].map((m) => (m[1] ?? '').toUpperCase());
}

/** The fields a chat tool addresses a row BY; `registry.ts` documents `documentId` as the one that also takes the short `ISS-<n>`. */
const TARGET_FIELDS = ['documentId', 'issueId'] as const;

// cm:guard the ref a write TARGETS, never every ref its arguments mention: a body quoting `ISS-2` inside a successful update of `ISS-1` would otherwise mark ISS-2 written and silence a real claim about it, and the same quote inside a refused call would be reported as that call's subject. Both directions are wrong and neither is visible in a passing test that puts one ref in the arguments (ISS-1008).
function targetRefsOf(record: ToolCallRecord): string[] {
  const argv = cliArgvOf(record);
  if (argv) {
    const target = cliWriteOf(argv)?.target;
    return target ? [target] : [];
  }
  try {
    const parsed = JSON.parse(record.arguments || '{}') as Record<string, unknown>;
    const refs: string[] = [];
    for (const field of TARGET_FIELDS) {
      const value = parsed[field];
      if (typeof value === 'string') refs.push(...refsIn(value));
    }
    return refs;
  } catch {
    return [];
  }
}

// cm:guard split on sentence enders AND newlines: a chat reply is often a bullet list with no full stops, and joining those lines would let a success phrase on one bullet answer for a ref on another — the over-firing the per-sentence rule exists to stop.
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function claimsCreated(sentence: string): boolean {
  return CREATED_RE.test(sentence) || CREATED_VI_RE.test(sentence);
}

function claimsLanded(sentence: string): boolean {
  if (DENIED_RE.test(sentence) || DENIED_VI_RE.test(sentence)) return false;
  return LANDED_RE.test(sentence) || LANDED_VI_RE.test(sentence);
}

/**
 * A turn's writes, split by what actually happened to them.
 *
 * `landed` is the half that wins over prose: a ref this turn wrote successfully
 * cannot also have been refused, whatever a sentence says about it.
 */
function partitionWrites(calls: readonly ToolCallRecord[]): {
  refused: ToolCallRecord[];
  landedRefs: Set<string>;
  landedCreate: boolean;
} {
  const refused: ToolCallRecord[] = [];
  const landedRefs = new Set<string>();
  let landedCreate = false;
  for (const call of calls) {
    const action = actionOf(call);
    if (!action || !WRITE_ACTIONS.has(action)) continue;
    if (call.isError) {
      refused.push(call);
      continue;
    }
    for (const ref of targetRefsOf(call)) landedRefs.add(ref);
    if (action === 'create') landedCreate = true;
  }
  return { refused, landedRefs, landedCreate };
}

/**
 * The probe. A verdict only — nothing here rewrites, refuses or blocks.
 *
 * @param finalText the reply as delivered
 * @param calls     every audited call of the turn, refused and landed alike
 */
// cm:guard LOG-ONLY, and the hard refusal is deliberately NOT here: the false-positive rate is unmeasured, and a probe that silences a reply on its first day cannot be told from one that silences correct replies. `chat_logs` stores `reply` beside `tool_calls`, so the window this opens is what decides whether a refusal is earned (ISS-1008).
export function detectStateConfab(
  finalText: string,
  calls: readonly ToolCallRecord[],
): ConfabProbe {
  const text = (finalText ?? '').trim();
  if (text.length === 0 || calls.length === 0) return NOTHING;

  const { refused, landedRefs, landedCreate } = partitionWrites(calls);
  if (refused.length === 0) return NOTHING;

  const claims: ConfabClaim[] = [];
  // cm:guard the FIRST refused create in call order names the claim, which matters only when two tools both had a create refused in one turn: any choice is arbitrary, so it is fixed here and asserted rather than left to read as an accident of `find` (ISS-1008).
  const refusedCreate = refused.find((call) => actionOf(call) === 'create');
  for (const sentence of sentencesOf(text)) {
    if (!claimsLanded(sentence)) continue;
    const said = new Set(refsIn(sentence));
    const before = claims.length;
    for (const call of refused) {
      for (const ref of targetRefsOf(call)) {
        if (said.has(ref) && !landedRefs.has(ref))
          claims.push({ tool: call.name, subject: ref, sentence });
      }
    }
    if (claims.length > before) continue;
    // cm:guard the ref-less arm is chosen by the CALL carrying no target and the sentence claiming a CREATION — never by the sentence carrying no ref. A refused create answered with "ISS-999 has been created" invents a ref, the worse confabulation, which a `said.size === 0` test excused; and suppressing on any landed ref in the sentence hid "ISS-999 has been created alongside ISS-1" behind ISS-1 (ISS-1008).
    if (!refusedCreate || landedCreate || !claimsCreated(sentence)) continue;
    claims.push({ tool: refusedCreate.name, subject: null, sentence });
  }
  return { suspected: claims.length > 0, claims };
}
