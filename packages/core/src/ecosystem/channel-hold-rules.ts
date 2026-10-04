import { parseVersionedDocument } from '../project-config/index.js';
import { heldThreads } from './channel-rules.js';
import { type ChannelDocument, holdSchema, type ThreadHold } from './channel-schema.js';
import { type Checked, type EcosystemRefusal, renameHoldParseRefusals } from './refusals.js';

export interface HoldWorld {
  documents: ReadonlyMap<string, ChannelDocument>;
  mayActFor: (personId: string, projectId: string) => boolean;
  holds: readonly ThreadHold[];
}

export function holdRefusals(h: ThreadHold, w: HoldWorld): EcosystemRefusal[] {
  const thread = w.documents.get(h.thread);
  if (!thread) {
    return [
      {
        code: 'REF_UNRESOLVED',
        path: '/thread',
        detail: `no published document ${h.thread} opens a conversation in this channel.`,
      },
    ];
  }
  const out: EcosystemRefusal[] = [];
  if (h.by.kind !== 'person') {
    out.push({
      code: 'HOLD_NOT_AUTHORISED',
      path: '/by',
      detail: `an agent never holds or releases a conversation; a person on either side does, under their own name.`,
    });
  } else if (!w.mayActFor(h.by.id, h.side)) {
    out.push({
      code: 'HOLD_NOT_AUTHORISED',
      path: '/by',
      detail: `${h.by.id} holds no member role or above on project ${h.side}, so cannot ${h.action} for that side.`,
    });
  }
  if (h.side !== thread.from && !thread.to.includes(h.side)) {
    out.push({
      code: 'HOLD_NOT_AUTHORISED',
      path: '/side',
      detail: `project ${h.side} is neither the sender nor a recipient of ${h.thread}; only a party to the conversation holds it.`,
    });
  }
  const held = heldThreads(w.holds).has(h.thread);
  if (h.action === 'hold' && held) {
    out.push({
      code: 'THREAD_ALREADY_HELD',
      path: '/thread',
      detail: `${h.thread} is already held; it is released before it is held again.`,
    });
  }
  if (h.action === 'release' && !held) {
    out.push({
      code: 'THREAD_NOT_HELD',
      path: '/thread',
      detail: `${h.thread} is not held, so there is nothing to release.`,
    });
  }
  return out;
}

export function parseHold(raw: unknown): Checked<ThreadHold> {
  const parsed = parseVersionedDocument(holdSchema, raw, 'hold');
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, refusals: renameHoldParseRefusals(parsed.refusals) };
}
