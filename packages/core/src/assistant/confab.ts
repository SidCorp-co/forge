import { CHANNEL_WRITES } from '../ecosystem/index.js';

/** What the claim check reads of an audited call; a `ToolCallRecord` is one. */
export interface ClaimCall {
  name: string;
  arguments: string;
  isError?: boolean | undefined;
  refusalCode?: string | null | undefined;
}

/** A display ref as the model writes one, in the arguments and in the prose. */
const SUBJECT_RE = /\b([A-Z][A-Z0-9]*-(?:(?:CN|ACK|RFI|CR|DEC)-)?\d+)\b/gu;

/** `action` values that change a row. A refused read is not a claim about state. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set(['create', 'update', 'mark', 'unmark']);

const LANDED_RE =
  /\b(?:has|have|was|were|is|are)\s+(?:now\s+)?(?:been\s+)?(?:set|updated?|created?|moved?|changed?|marked?|closed?|opened?|filed?|sent|published|submitted|held|released|withdrawn|superseded|approved|returned|drafted)\b|\bi(?:'ve|\s+have)?\s+(?:set|updated?|created?|moved?|marked?|changed?|closed?|filed?|sent|published|submitted|held|released|withdrew|superseded|approved|returned|drafted)\b|\b(?:successfully|done)\b/iu;

const DENIED_RE =
  /\b(?:not|never|cannot|unable|fail(?:ed|s|ure)?|refus(?:ed|es|al)|reject(?:ed|s)?|declin(?:ed|es))\b|\bno\s+(?:way|longer)\b|n['\u2019]t\b/iu;

/** The same withdrawal in the language the Rocket.Chat door answers in; written without `\b`, which is ASCII-only in JS and would not close on a diacritic. */
// the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only.
const DENIED_VI_RE = /không|chưa|thất\s*bại|từ\s*chối/iu; // i18n-allow: the phrases this matches are the ones that door's own replies are written in

const CREATED_RE =
  /\b(?:created|filed|raised|logged|opened|sent|published|submitted|held|released|withdr[ae]wn?|superseded|approved|returned|drafted)\b/iu;

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
  /** The refused call, in the words the correction names it by. */
  action: string;
  /** What the refused call named as its target, or null where it named none. */
  target: string | null;
  /** The code the refusal carried, or null where its result named none. */
  refusalCode: string | null;
}

export interface ConfabProbe {
  suspected: boolean;
  claims: ConfabClaim[];
}

const NOTHING: ConfabProbe = { suspected: false, claims: [] };

const CLI_TOOL = 'forge';
const CHANNEL_TOOL = 'forge_channel';
const CHANNEL_WRITE_SET: ReadonlySet<string> = new Set(CHANNEL_WRITES);
/** The fields a channel call names a document or conversation by. */
const CHANNEL_TARGET_FIELDS = ['ref', 'thread', 'inReplyTo'] as const;
const CLI_SET_FLAGS: ReadonlySet<string> = new Set(['--set', '--blocks', '--relates', '--unlink']);

function argsOf(record: ClaimCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(record.arguments || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cliArgvOf(record: ClaimCall): string[] | null {
  if (record.name !== CLI_TOOL) return null;
  const { argv } = argsOf(record);
  return Array.isArray(argv) && argv.every((a) => typeof a === 'string') ? argv : null;
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

// cm:why a channel write is a write whatever its verb, and one that names no published number (a draft, a reply, a submit by uuid) is claimed like a create: the reply can only invent the number
function channelActionOf(record: ClaimCall): string | null {
  const action = argsOf(record).action;
  if (typeof action !== 'string' || !CHANNEL_WRITE_SET.has(action)) return null;
  return targetRefsOf(record).length > 0 ? 'update' : 'create';
}

function actionOf(record: ClaimCall): string | null {
  const argv = cliArgvOf(record);
  if (argv) return cliWriteOf(argv)?.action ?? null;
  if (record.name === CHANNEL_TOOL) return channelActionOf(record);
  const { action } = argsOf(record);
  return typeof action === 'string' ? action : null;
}

/** Every display ref named anywhere in a string — right for a sentence, wrong for a call's arguments. */
function refsIn(text: string): string[] {
  return [...text.matchAll(SUBJECT_RE)].map((m) => (m[1] ?? '').toUpperCase());
}

/** The fields a chat tool addresses a row BY; `registry.ts` documents `documentId` as the one that also takes the short `ISS-<n>`. */
const TARGET_FIELDS = ['documentId', 'issueId'] as const;

function targetRefsOf(record: ClaimCall): string[] {
  const argv = cliArgvOf(record);
  if (argv) {
    const target = cliWriteOf(argv)?.target;
    return target ? [target] : [];
  }
  const args = argsOf(record);
  const fields = record.name === CHANNEL_TOOL ? CHANNEL_TARGET_FIELDS : TARGET_FIELDS;
  return fields.flatMap((field) => {
    const value = args[field];
    return typeof value === 'string' ? refsIn(value) : [];
  });
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
function partitionWrites(calls: readonly ClaimCall[]): {
  refused: ClaimCall[];
  landedRefs: Set<string>;
  landedCreate: boolean;
} {
  const refused: ClaimCall[] = [];
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

function namedCall(call: ClaimCall): Pick<ConfabClaim, 'action' | 'target' | 'refusalCode'> {
  const argv = cliArgvOf(call);
  const args = argsOf(call);
  const verb = argv ? `forge ${argv[0] ?? ''}`.trim() : String(args.action ?? call.name);
  const named =
    typeof args.ref === 'string' ? args.ref : typeof args.thread === 'string' ? args.thread : null;
  return {
    action: verb,
    target: targetRefsOf(call)[0] ?? (argv ? null : named),
    refusalCode: call.refusalCode ?? null,
  };
}

/** The line a reader is shown for one refused write the reply told as done. */
export function correctionLine(claim: ConfabClaim): string {
  const of = claim.target ? ` of ${claim.target}` : '';
  const code = claim.refusalCode ?? 'no refusal code was given';
  return `Correction: the ${claim.action}${of} was refused (${code}); nothing was written.`;
}

// cm:why a caught claim is corrected in the text the person reads, not only logged: the false sentence stays, and a code-written line under it names the refused call, its code, and that nothing was written
export function correctFalseClaims(
  text: string,
  calls: readonly ClaimCall[],
): { text: string; probe: ConfabProbe } {
  const probe = detectStateConfab(text, calls);
  const lines = [...new Set(probe.claims.map(correctionLine))].filter((l) => !text.includes(l));
  if (lines.length === 0) return { text, probe };
  return { text: `${text.trimEnd()}\n\n${lines.join('\n')}`, probe };
}

/**
 * The probe. A verdict only — nothing here rewrites, refuses or blocks.
 *
 * @param finalText the reply as delivered
 * @param calls     every audited call of the turn, refused and landed alike
 */
export function detectStateConfab(finalText: string, calls: readonly ClaimCall[]): ConfabProbe {
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
          claims.push({ tool: call.name, subject: ref, sentence, ...namedCall(call) });
      }
    }
    if (claims.length > before) continue;
    if (!refusedCreate || landedCreate || !claimsCreated(sentence)) continue;
    claims.push({ tool: refusedCreate.name, subject: null, sentence, ...namedCall(refusedCreate) });
  }
  return { suspected: claims.length > 0, claims };
}
