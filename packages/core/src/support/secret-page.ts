// A project's Secrets page, read whole (ISS-1348, owner 2026-11-19): what agents asked for comes
// first, each request with who asked, when, why, its environment and the value's shape, then every
// secret the project holds grouped by what uses it (`secret-page-slots.ts`). A request whose slot
// already holds a value says so, with when and by whom, and that nothing is to do. Nothing here
// answers a value: an agent reading it learns key names, scopes and shapes alone (REQ-80 BC-6).

import type {
  SecretHeld,
  SecretRequestView,
  SecretSlotView,
  SecretSlotsRead,
} from '@forge/contracts/secret-slots';
import { secretFormOf } from '@forge/contracts/secret-slots';
import { userNames } from '../lib/people.js';
import { anchorOf, labelOf, slotGroups, slotStoresOf, variableSlot } from './secret-page-slots.js';
import { type AskRow, asksOfProject } from './secret-asks.js';

const SAYS =
  'No value is answered here, only whether each slot holds one. A request is filled on this page or with its one-time write URL; an agent asks for one with support.secret_link.';

const filledOf = (ask: AskRow, names: Map<string, string>): SecretHeld | null =>
  ask.filledAt
    ? {
        at: ask.filledAt.toISOString(),
        by: ask.filledBy ? (names.get(ask.filledBy) ?? null) : null,
        via: ask.filledVia ?? null,
      }
    : null;

/** The slot an ask names where no group lists it: a variable not held yet, or a slot gone since. */
function askedSlot(ask: AskRow): SecretSlotView | null {
  const s = ask.slot;
  if (ask.kind !== 'testing' || !s.ref) return null;
  const [, scope = '', name = ''] = /^secret:\/\/([^/]+)\/(.+)$/.exec(s.ref) ?? [];
  const slotName = s.actor ?? s.service ?? name;
  return {
    anchor: anchorOf(ask.slotKey),
    ref: { kind: 'testing', profile: s.profile ?? '', ...(s.actor ? { actor: s.actor } : { service: slotName }) },
    label: labelOf(slotName),
    detail: `${s.profile} · ${slotName}`,
    environment: null,
    tier: null,
    door: { kind: 'secret', scope, name },
    form: secretFormOf('value'),
    held: null,
  };
}

export async function readSecretSlots(projectId: string): Promise<SecretSlotsRead> {
  const [stores, asks] = await Promise.all([slotStoresOf(projectId), asksOfProject(projectId)]);
  stores.names = await userNames([
    ...stores.variables.map((v) => v.updatedBy),
    ...[...stores.fills.values()].map((f) => f.by),
    ...asks.map((a) => a.filledBy),
  ]);
  const bySlot = new Map<string, AskRow[]>();
  for (const ask of asks) bySlot.set(ask.slotKey, [...(bySlot.get(ask.slotKey) ?? []), ask]);
  const lastFilled = (slotKey: string) => {
    const filled = (bySlot.get(slotKey) ?? []).find((a) => a.filledAt);
    return filled ? filledOf(filled, stores.names) : null;
  };
  // a variable asked for and not held yet is listed in its environment's group as missing
  const missing = [...bySlot.values()].flatMap(([newest]) =>
    newest?.kind === 'variable' &&
    !stores.variables.some(
      (v) => v.key === newest.slot.key && v.environment === (newest.slot.environment ?? null),
    )
      ? [variableSlot(stores, newest.slot.key ?? '', newest.slot.environment ?? null, null)]
      : [],
  );
  const groups = await slotGroups(stores, lastFilled, missing);
  const listed = new Map(groups.flatMap((g) => g.slots).map((v) => [v.anchor, v]));
  const requests = [...bySlot.values()].flatMap(([newest, ...older]): SecretRequestView[] => {
    if (!newest) return [];
    const slot = listed.get(anchorOf(newest.slotKey)) ?? askedSlot(newest);
    if (!slot) return [];
    const all = [newest, ...older];
    return [
      {
        id: newest.id,
        askIds: all.map((a) => a.id),
        slot: newest.shape ? { ...slot, form: secretFormOf(newest.shape) } : slot,
        why: newest.why,
        example: newest.example,
        askedAt: newest.createdAt.toISOString(),
        askedFor: newest.askedFor,
        filled: lastFilled(newest.slotKey),
      },
    ];
  });
  // waiting first: neither filled through its request nor held by its slot
  const waiting = (r: SecretRequestView) => r.filled === null && r.slot.held === null;
  return {
    requests: [...requests.filter(waiting), ...requests.filter((r) => !waiting(r))],
    groups,
    says: SAYS,
  };
}
