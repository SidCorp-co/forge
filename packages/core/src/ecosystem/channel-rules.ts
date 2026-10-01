import { parseVersionedDocument, pointer } from '../project-config/documents.js';
import { contentRefusals, internalNamesOf } from './channel-content.js';
import {
  type ChannelDocument,
  type Classification,
  documentSchema,
  holdSchema,
  type ThreadHold,
  TYPE_CODES,
} from './channel-schema.js';
import type { ContractFacts } from './contract/citations.js';
import { elementRefusals } from './contract/element-rules.js';
import { compareVersions } from './contract/naming.js';
import { splitContractRef, versionKey } from './interface-rules.js';
import {
  type Checked,
  type EcosystemRefusal,
  renameDocumentParseRefusals,
  renameHoldParseRefusals,
} from './refusals.js';
import type { DocumentType, EcosystemDocument, InterfaceDocument } from './schema.js';
import type { EdgeRow } from './store.js';

export type { MeasuredVersion } from './contract/citations.js';

export interface ChannelWorld {
  today: string;
  ecosystemId: string;
  ecosystem: EcosystemDocument;
  active: ReadonlySet<string>;
  slugOf: ReadonlyMap<string, string>;
  interfaces: ReadonlyMap<string, InterfaceDocument>;
  edges: readonly EdgeRow[];
  versions: ReadonlyMap<string, ReadonlySet<string>>;
  contracts: ContractFacts;
  documents: ReadonlyMap<string, ChannelDocument>;
  holds: readonly ThreadHold[];
}

export const REPLIES: Readonly<Record<DocumentType, readonly DocumentType[]>> = {
  'change-notice': ['acknowledgement'],
  rfi: ['decision'],
  'change-request': ['decision'],
  acknowledgement: [],
  decision: [],
};

const ENDED = new Set(['withdrawn', 'superseded']);

export function heldThreads(holds: readonly ThreadHold[]): Map<string, ThreadHold> {
  const last = new Map<string, ThreadHold>();
  for (const h of [...holds].sort((a, b) => a.at.localeCompare(b.at))) last.set(h.thread, h);
  return new Map([...last].filter(([, h]) => h.action === 'hold'));
}

export function threadRoot(
  doc: Pick<ChannelDocument, 'number' | 'inReplyTo'>,
  documents: ReadonlyMap<string, ChannelDocument>,
): string | null {
  const seen = new Set<string>();
  let at: Pick<ChannelDocument, 'number' | 'inReplyTo'> | undefined = doc;
  while (at?.inReplyTo) {
    if (seen.has(at.inReplyTo)) return null;
    seen.add(at.inReplyTo);
    const parent = documents.get(at.inReplyTo);
    if (!parent) return null;
    at = parent;
  }
  return at === doc ? (doc.number ?? null) : (at?.number ?? null);
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export function olderThan(versioning: 'dated' | 'semver', a: string, b: string): boolean {
  return compareVersions(versioning, a, b) < 0;
}

const isCounterparty = (w: ChannelWorld, a: string, b: string) =>
  w.edges.some(
    (e) =>
      e.ecosystemId === w.ecosystemId &&
      ((e.consumerProjectId === a && e.providerProjectId === b) ||
        (e.consumerProjectId === b && e.providerProjectId === a)),
  );

function partyRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  const name = (id: string) => w.slugOf.get(id) ?? id;
  if (!w.active.has(d.from)) {
    out.push({
      code: 'MEMBERSHIP_NOT_ACTIVE',
      path: '/from',
      detail: `${name(d.from)} is not an active member of ecosystem ${w.ecosystem.ecosystem.slug}; only an active member sends in its channel.`,
    });
  }
  d.to.forEach((to, i) => {
    if (!w.active.has(to)) {
      out.push({
        code: 'MEMBERSHIP_NOT_ACTIVE',
        path: pointer(['to', i]),
        detail: `${name(to)} is not an active member of ecosystem ${w.ecosystem.ecosystem.slug}; a document goes only to active members.`,
      });
    } else if (!isCounterparty(w, d.from, to)) {
      out.push({
        code: 'RECIPIENT_NOT_COUNTERPARTY',
        path: pointer(['to', i]),
        detail: `${name(to)} neither consumes from nor publishes to ${name(d.from)} in this ecosystem; a document goes only to a counterparty.`,
      });
    }
  });
  return out;
}

function numberRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  if (!d.number) return [];
  const out: EcosystemRefusal[] = [];
  const code = w.ecosystem.channel.code;
  if (!d.number.startsWith(`${code}-`)) {
    out.push({
      code: 'NUMBER_NOT_IN_CHANNEL',
      path: '/number',
      detail: `${d.number} is not a number of channel ${code}; every number here starts ${code}-.`,
    });
  }
  if (d.number.split('-')[1] !== TYPE_CODES[d.type]) {
    out.push({
      code: 'NUMBER_TYPE_MISMATCH',
      path: '/number',
      detail: `${d.number} does not carry ${TYPE_CODES[d.type]}, the code of a ${d.type}.`,
    });
  }
  return out;
}

function gateRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  const g = d.gate;
  if (d.state === 'published' && g?.mode === 'approve' && g.decision !== 'approved') {
    out.push({
      code: 'PUBLISHED_WITHOUT_GATE',
      path: '/gate',
      detail: `a ${d.type} in this ecosystem is approved by a person before it is published, and this one carries no approval.`,
    });
  }
  if (g?.decision === 'returned' && !g.note) {
    out.push({
      code: 'GATE_RETURN_WITHOUT_NOTE',
      path: '/gate/note',
      detail: 'a returned document says what to change: the note is required.',
    });
  }
  const mode = w.ecosystem.gate[d.type];
  if (g && g.mode !== mode) {
    out.push({
      code: 'GATE_MODE_MISMATCH',
      path: '/gate/mode',
      detail: `ecosystem ${w.ecosystem.ecosystem.slug} gates a ${d.type} with "${mode}", and this document carries "${g.mode}"; the gate is the ecosystem's, copied at submit.`,
    });
  }
  return out;
}

function replyRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  if (!d.inReplyTo) {
    if (d.type === 'acknowledgement' || d.type === 'decision') {
      out.push({
        code: 'REPLY_WITHOUT_PARENT',
        path: '/inReplyTo',
        detail: `a ${d.type} answers a published document; name it in inReplyTo.`,
      });
    }
    return out;
  }
  const parent = w.documents.get(d.inReplyTo);
  if (!parent) {
    out.push({
      code: 'REF_UNRESOLVED',
      path: '/inReplyTo',
      detail: `no published document ${d.inReplyTo} in channel ${w.ecosystem.channel.code}.`,
    });
    return out;
  }
  if (ENDED.has(parent.state)) {
    out.push({
      code: 'REPLY_TO_ENDED',
      path: '/inReplyTo',
      detail: `${d.inReplyTo} is ${parent.state}${parent.supersededBy ? ` by ${parent.supersededBy}` : ''}; answer the document that stands.`,
    });
  }
  if (!REPLIES[parent.type].includes(d.type)) {
    const allowed = REPLIES[parent.type];
    out.push({
      code: 'REPLY_TYPE_NOT_ALLOWED',
      path: '/inReplyTo',
      detail: `a ${parent.type} is answered ${allowed.length ? `only by ${allowed.join(' or ')}` : 'by nothing'}, not by a ${d.type}.`,
    });
  }
  if (!parent.to.includes(d.from)) {
    out.push({
      code: 'REPLY_FROM_NON_RECIPIENT',
      path: '/from',
      detail: `${d.inReplyTo} was not sent to ${w.slugOf.get(d.from) ?? d.from}; only a recipient answers it.`,
    });
  }
  if (d.type === 'decision') {
    const answered = d.body.disposition === 'answered';
    if ((parent.type === 'rfi') !== answered) {
      out.push({
        code: 'DISPOSITION_NOT_FOR_TYPE',
        path: '/body/disposition',
        detail:
          parent.type === 'rfi'
            ? `an RFI is decided "answered", not "${d.body.disposition}".`
            : `"answered" decides an RFI; a ${parent.type} is accepted, accepted-with-conditions, declined or deferred.`,
      });
    }
  }
  if (d.type === 'acknowledgement' && parent.type === 'change-notice') {
    const sunset = parent.body.deprecation?.sunsetOn;
    if (sunset && d.body.adaptBy && d.body.adaptBy > sunset) {
      out.push({
        code: 'ADAPT_AFTER_SUNSET',
        path: '/body/adaptBy',
        detail: `${d.inReplyTo} sunsets on ${sunset}; adapting by ${d.body.adaptBy} is after the old behaviour is gone.`,
      });
    }
  }
  return out;
}

function changeNoticeRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  if (d.type !== 'change-notice') return [];
  const out: EcosystemRefusal[] = [];
  const b = d.body;
  const { provider, contract } = splitContractRef(b.contract);
  const sender = w.slugOf.get(d.from);
  if (provider !== sender) {
    out.push({
      code: 'CONTRACT_NOT_SENDERS',
      path: '/body/contract',
      detail: `${b.contract} is ${provider}'s contract; a change notice is sent by the project that publishes the contract.`,
    });
    return out;
  }
  const known = w.versions.get(versionKey(d.from, contract));
  if (!known?.has(b.contractVersion)) {
    out.push({
      code: 'VERSION_UNKNOWN',
      path: '/body/contractVersion',
      detail: `${b.contract} has no recorded version "${b.contractVersion}"; a notice cites a version core has recorded.`,
    });
  }
  const m = w.contracts.measured.get(`${b.contract}@${b.contractVersion}`);
  if (m) {
    const rank: Record<Classification, number> = { 'non-breaking': 0, unknown: 1, breaking: 2 };
    if (m.classification !== 'initial' && rank[b.classification] < rank[m.classification]) {
      out.push({
        code: 'CLASSIFICATION_BELOW_MEASURED',
        path: '/body/classification',
        detail: `${b.contractVersion} measured ${m.classification}; a notice may raise the classification, never lower it.`,
      });
    }
    for (const c of m.changes.filter((x) => x.level === 'breaking')) {
      if (!b.changes.some((x) => x.element === c.element)) {
        out.push({
          code: 'MEASURED_CHANGE_OMITTED',
          path: '/body/changes',
          detail: `the measured breaking change to ${c.element} is not among the changes; every measured breaking change is stated.`,
        });
      }
    }
  }
  if (b.classification === 'breaking' && d.dueBy && b.effectiveOn < d.dueBy) {
    out.push({
      code: 'EFFECTIVE_BEFORE_DUE',
      path: '/body/effectiveOn',
      detail: `a breaking change effective ${b.effectiveOn} lands before the replies due ${d.dueBy}; it takes effect on or after the due date.`,
    });
  }
  const iface = w.interfaces.get(d.from);
  if (b.deprecation && iface) {
    const days =
      (Date.parse(b.deprecation.sunsetOn) - Date.parse(b.deprecation.deprecatedOn)) / 864e5;
    if (days < iface.commitments.deprecationNoticeDays) {
      out.push({
        code: 'SUNSET_BEFORE_NOTICE_PERIOD',
        path: '/body/deprecation/sunsetOn',
        detail: `the sunset comes ${days} day(s) after deprecation, and ${sender} promises ${iface.commitments.deprecationNoticeDays}.`,
      });
    }
  }
  const versioning = iface?.commitments.versioning ?? 'dated';
  const owed = [
    ...new Set(
      w.edges
        .filter(
          (e) =>
            e.ecosystemId === w.ecosystemId &&
            e.providerProjectId === d.from &&
            e.contractSlug === contract &&
            w.active.has(e.consumerProjectId) &&
            olderThan(versioning, e.builtAgainst, b.contractVersion),
        )
        .map((e) => e.consumerProjectId),
    ),
  ].sort();
  if (JSON.stringify([...d.to].sort()) !== JSON.stringify(owed)) {
    const names = owed.map((id) => w.slugOf.get(id) ?? id);
    out.push({
      code: 'RECIPIENTS_NOT_DERIVED',
      path: '/to',
      detail: `a notice for ${b.contract} ${b.contractVersion} goes to every consumer built against an older version, and no one else: ${owed.length ? `${names.join(', ')} (${owed.join(', ')})` : 'none is owed one'}.`,
    });
  }
  return out;
}

function dueRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  if (d.state === 'published' || !d.dueBy) return [];
  const earliest = addDays(w.today, 1);
  return d.dueBy < earliest
    ? [
        {
          code: 'DUE_BY_TOO_SOON',
          path: '/dueBy',
          detail: `a reply cannot be owed before ${earliest}, tomorrow; ${d.dueBy} leaves the other side no day to answer.`,
        },
      ]
    : [];
}

function holdRefusalsFor(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  const root = threadRoot(d, w.documents);
  if (!root || root === d.number || d.authoredBy.kind !== 'agent') return [];
  const hold = heldThreads(w.holds).get(root);
  if (!hold) return [];
  return [
    {
      code: 'THREAD_HELD',
      path: '/inReplyTo',
      detail: `${root} is held by a person since ${hold.at} ("${hold.reason ?? ''}"); no agent adds to it until a person releases it. A person may still answer.`,
    },
  ];
}

export function documentRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  const iface = w.interfaces.get(d.from);
  const content = contentRefusals(d.subject, d.body, {
    channelCode: w.ecosystem.channel.code,
    internalNames: iface ? internalNamesOf(iface) : null,
  });
  const all = [
    ...partyRefusals(d, w),
    ...numberRefusals(d, w),
    ...gateRefusals(d, w),
    ...holdRefusalsFor(d, w),
    ...replyRefusals(d, w),
    ...changeNoticeRefusals(d, w),
    ...elementRefusals(d, w.documents, w.contracts),
    ...dueRefusals(d, w),
    ...content,
  ];
  const seen = new Set<string>();
  return all.filter((r) => {
    const key = `${r.code} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

export function parseChannelDocument(raw: unknown): Checked<ChannelDocument> {
  const parsed = parseVersionedDocument(documentSchema, raw, 'channel');
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, refusals: renameDocumentParseRefusals(parsed.refusals) };
}

export function parseHold(raw: unknown): Checked<ThreadHold> {
  const parsed = parseVersionedDocument(holdSchema, raw, 'hold');
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, refusals: renameHoldParseRefusals(parsed.refusals) };
}
