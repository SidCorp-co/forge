import type { ToolCallRecord } from './run-turn-core.js';

/** A display ref as the model writes one, in the arguments and in the prose. */
const SUBJECT_RE = /\b([A-Z][A-Z0-9]*-\d+)\b/gu;

/** `action` values that change a row. A refused read is not a claim about state. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set(['create', 'update', 'mark', 'unmark']);

const LANDED_RE =
  /\b(?:has|have|was|were|is|are)\s+(?:now\s+)?(?:been\s+)?(?:set|updated?|created?|moved?|changed?|marked?|closed?|opened?|filed?)\b|\bi(?:'ve|\s+have)?\s+(?:set|updated?|created?|moved?|marked?|changed?|closed?|filed?)\b|\b(?:successfully|done)\b/iu;

const DENIED_RE =
  /\b(?:not|never|cannot|unable|fail(?:ed|s|ure)?|refus(?:ed|es|al)|reject(?:ed|s)?|declin(?:ed|es))\b|\bno\s+(?:way|longer)\b|n['\u2019]t\b/iu;

/** The same withdrawal in the language the Rocket.Chat door answers in; written without `\b`, which is ASCII-only in JS and would not close on a diacritic. */
// the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only.
const DENIED_VI_RE = /không|chưa|thất\s*bại|từ\s*chối/iu; // i18n-allow: the phrases this matches are the ones that door's own replies are written in

const CREATED_RE = /\b(?:created|filed|raised|logged|opened)\b/iu;

const CREATED_VI_RE = /đã\s+(?:được\s+)?tạo/iu; // i18n-allow: the phrases this matches are the ones that door's own replies are written in

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
export function detectStateConfab(
  finalText: string,
  calls: readonly ToolCallRecord[],
): ConfabProbe {
  const text = (finalText ?? '').trim();
  if (text.length === 0 || calls.length === 0) return NOTHING;

  const { refused, landedRefs, landedCreate } = partitionWrites(calls);
  if (refused.length === 0) return NOTHING;

  const claims: ConfabClaim[] = [];
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
    if (!refusedCreate || landedCreate || !claimsCreated(sentence)) continue;
    claims.push({ tool: refusedCreate.name, subject: null, sentence });
  }
  return { suspected: claims.length > 0, claims };
}
