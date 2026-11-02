// A support room's binding as the settings form edits it (REQ-75 r5 BC-25): the form's state, the
// `support` block it writes, and the schema's own messages by field. The schema is the contract's
// (`supportRoomConfigSchema`), so what the form refuses is what core would refuse.

import {
  SUPPORT_ABILITIES,
  type SupportAbility,
  type SupportAnswers,
  type SupportReaders,
  type SupportRoomConfig,
  supportRoomConfigSchema,
} from "@forge/contracts/support";

export interface SupportRoomState {
  rid: string;
  product: string;
  persona: string;
  readers: SupportReaders;
  answers: SupportAnswers;
  abilities: SupportAbility[];
  deployTargets: string[];
  /** Comma- or space-separated, as typed. */
  hosts: string;
  confirmers: string;
}

/**
 * What the form does not edit and a save carries over unchanged: the limits, and the reads an
 * `ops_reads` grant declares (ISS-871), which are set in the binding document.
 */
export type SupportCarried = Pick<SupportRoomConfig, "limits"> & {
  reads?: NonNullable<SupportRoomConfig["grants"]>["reads"];
};

/** The field a schema message is shown under. */
export type SupportRoomField =
  | "rid"
  | "product"
  | "persona"
  | "abilities"
  | "deployTargets"
  | "hosts"
  | "confirmers"
  | "limits";

const words = (typed: string): string[] =>
  typed
    .split(/[\s,]+/)
    .map((w) => w.trim().replace(/^@/, ""))
    .filter(Boolean);

/** The form as it opens: from a binding's `support` block and room, or empty. */
export function stateOf(support: SupportRoomConfig | null | undefined, rid: string): SupportRoomState {
  const grants = support?.grants;
  return {
    rid,
    product: support?.product ?? "",
    persona: support?.persona ?? "",
    readers: support?.readers ?? "users",
    answers: support?.answers ?? "every-message",
    abilities: SUPPORT_ABILITIES.filter((a) => grants?.abilities.includes(a)),
    deployTargets: grants?.deployTargets ?? [],
    hosts: (grants?.hosts ?? []).join(", "),
    confirmers: (grants?.confirmers ?? []).join(", "),
  };
}

/**
 * The `support` block the form writes. An empty text is left out rather than sent blank; a list the
 * room's abilities do not use is left out, so unticking deploy drops its targets with it. No ability
 * ticked writes no `grants`, which core reads as a room holding none. `limits` and the declared
 * `reads` the form does not edit are carried over unchanged.
 */
export function supportBlockOf(
  state: SupportRoomState,
  carried?: SupportCarried,
): Record<string, unknown> {
  const has = (a: SupportAbility) => state.abilities.includes(a);
  const confirmed = has("build") || has("deploy") || has("run_commands");
  const grants =
    state.abilities.length === 0
      ? undefined
      : {
          abilities: SUPPORT_ABILITIES.filter(has),
          ...(has("deploy") ? { deployTargets: state.deployTargets } : {}),
          ...(has("run_commands") ? { hosts: words(state.hosts) } : {}),
          ...(has("ops_reads") && carried?.reads ? { reads: carried.reads } : {}),
          ...(confirmed ? { confirmers: words(state.confirmers) } : {}),
        };
  return {
    ...(state.product.trim() ? { product: state.product.trim() } : {}),
    ...(state.persona.trim() ? { persona: state.persona.trim() } : {}),
    readers: state.readers,
    answers: state.answers,
    ...(grants ? { grants } : {}),
    ...(carried?.limits ? { limits: carried.limits } : {}),
  };
}

/** What a save writes on the binding: its one room and the support block, together. */
export function supportSaveConfig(
  state: SupportRoomState,
  carried?: SupportCarried,
): { rids: string[]; support: Record<string, unknown> } {
  return { rids: [state.rid.trim()], support: supportBlockOf(state, carried) };
}

/** The schema's messages by field, empty when the block is one core takes. */
export function supportRoomErrors(
  state: SupportRoomState,
  carried?: SupportCarried,
): Partial<Record<SupportRoomField, string>> {
  const errors: Partial<Record<SupportRoomField, string>> = {};
  if (!state.rid.trim()) errors.rid = "pick the group this room answers";
  const parsed = supportRoomConfigSchema.safeParse(supportBlockOf(state, carried));
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const [head, sub] = issue.path;
    const field = (head === "grants" ? (sub ?? "abilities") : head) as SupportRoomField;
    errors[field] ??= issue.message;
  }
  return errors;
}
