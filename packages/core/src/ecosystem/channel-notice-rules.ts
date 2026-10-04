import { addDays, type ChannelWorld } from './channel-rules.js';
import type { ChannelDocument, Classification } from './channel-schema.js';
import type { MeasuredVersion } from './contract/citations.js';
import { linkImpact, recipientsOf } from './contract/impact.js';
import { splitContractRef, versionKey } from './interface-rules.js';
import type { EcosystemRefusal } from './refusals.js';

type Notice = Extract<ChannelDocument, { type: 'change-notice' }>;

const RANK: Record<Classification, number> = { 'non-breaking': 0, unknown: 1, breaking: 2 };

function measuredRefusals(b: Notice['body'], m: MeasuredVersion | undefined): EcosystemRefusal[] {
  if (!m) return [];
  const out: EcosystemRefusal[] = [];
  if (m.classification !== 'initial' && RANK[b.classification] < RANK[m.classification]) {
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
  return out;
}

function deadlineRefusals(d: Notice, w: ChannelWorld, sender: string | undefined) {
  const out: EcosystemRefusal[] = [];
  const b = d.body;
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
  const reachable = w.contracts.versions.get(`${b.contract}@${b.contractVersion}`)?.recordedOn;
  const notice = iface?.commitments.deprecationNoticeDays ?? 0;
  if (b.classification === 'breaking' && reachable) {
    const earliest = addDays(reachable, notice);
    if (b.effectiveOn < earliest) {
      out.push({
        code: 'DEADLINE_BEFORE_REACHABLE',
        path: '/body/effectiveOn',
        detail: `${b.contractVersion} was recorded on ${reachable} and ${sender} promises ${notice} day(s) of notice, so a breaking change takes effect on or after ${earliest}, not ${b.effectiveOn}.`,
      });
    }
  }
  return out;
}

function recipientRefusals(
  d: Notice,
  w: ChannelWorld,
  contract: string,
  m: MeasuredVersion | undefined,
): EcosystemRefusal[] {
  const b = d.body;
  const versioning = w.interfaces.get(d.from)?.commitments.versioning ?? 'dated';
  const declared = w.edges
    .filter(
      (e) =>
        e.ecosystemId === w.ecosystemId &&
        e.providerProjectId === d.from &&
        e.contractSlug === contract &&
        w.active.has(e.consumerProjectId),
    )
    .map((e) => e.consumerProjectId);
  const impacts = w.links
    .filter((l) => l.provider === d.from && l.contractSlug === contract && w.active.has(l.consumer))
    .map((l) => linkImpact(versioning, b.contractVersion, m ?? null, l));
  const owed = recipientsOf(declared, impacts);
  const ids = owed.map((r) => r.consumer);
  if (JSON.stringify([...d.to].sort()) === JSON.stringify(ids)) return [];
  const names = owed.map((r) => `${w.slugOf.get(r.consumer) ?? r.consumer} (${r.reason})`);
  return [
    {
      code: 'RECIPIENTS_NOT_DERIVED',
      path: '/to',
      detail: `a notice for ${b.contract} ${b.contractVersion} goes to every consumer it breaks, every consumer core could not measure it against and every consumer with no link, and no one else: ${owed.length ? names.join(', ') : 'none is owed one'}.`,
    },
  ];
}

export function changeNoticeRefusals(d: ChannelDocument, w: ChannelWorld): EcosystemRefusal[] {
  if (d.type !== 'change-notice') return [];
  const b = d.body;
  const { provider, contract } = splitContractRef(b.contract);
  const sender = w.slugOf.get(d.from);
  if (provider !== sender) {
    return [
      {
        code: 'CONTRACT_NOT_SENDERS',
        path: '/body/contract',
        detail: `${b.contract} is ${provider}'s contract; a change notice is sent by the project that publishes the contract.`,
      },
    ];
  }
  const known = w.versions.get(versionKey(d.from, contract));
  const unknown: EcosystemRefusal[] = known?.has(b.contractVersion)
    ? []
    : [
        {
          code: 'VERSION_UNKNOWN',
          path: '/body/contractVersion',
          detail: `${b.contract} has no recorded version "${b.contractVersion}"; a notice cites a version core has recorded.`,
        },
      ];
  const m = w.contracts.measured.get(`${b.contract}@${b.contractVersion}`);
  return [
    ...unknown,
    ...measuredRefusals(b, m),
    ...deadlineRefusals(d, w, sender),
    ...recipientRefusals(d, w, contract, m),
  ];
}
