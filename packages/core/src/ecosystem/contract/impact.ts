import { type CallSite, callSiteAt } from '../link-schema.js';
import type { ChangeKind, ChangeLevel, MeasuredClassification } from './diff.js';
import { compareVersions, type Versioning } from './naming.js';

export type ImpactCallSite = CallSite;

export interface ImpactLink {
  id: string;
  consumer: string;
  module: string;
  pinnedVersion: string;
  callSites: readonly ImpactCallSite[];
  fieldsUsed: readonly string[];
  outsideContract: readonly string[];
}

export interface ImpactChange {
  element: string;
  level: ChangeLevel;
  kind: ChangeKind;
  text: string;
  check?: string | undefined;
}

interface ImpactMeasurement {
  classification: MeasuredClassification;
  changes: readonly ImpactChange[];
}

export interface ImpactBreak {
  element: string;
  check: string | null;
  text: string;
  fields: string[];
  callSites: ImpactCallSite[];
  outsideContract: string[];
}

type LinkReason = 'no-breaking-change-touches' | 'built-against' | 'touched' | 'unmeasured';

export interface LinkImpact {
  link: string;
  consumer: string;
  module: string;
  pinnedVersion: string;
  verdict: 'passes' | 'breaks';
  reason: LinkReason;
  breaks: ImpactBreak[];
}

type RecipientReason = 'breaks' | 'unmapped' | 'unmeasured';

export interface Recipient {
  consumer: string;
  reason: RecipientReason;
  links: string[];
}

const INPUT = /request|became-required|new-required/;
const WHOLE = new Set(['document', '#']);
const OPERATION = /^[A-Z]+ \//;
const unescapePointer = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
const leaf = (f: string) => f.split(/[./]/).filter(Boolean).pop() ?? f;

// an added or newly required input binds every caller of the surface whatever it reads, so only a removed or changed property a consumer reads narrows the break to that consumer
// a change's element is `<operation>/properties/<a>/properties/<b>` from the schema differ, or an operation whose text quotes the property from oasdiff; the part before the first property is the surface, the properties are the fields
function shapeOf(c: ImpactChange): { surface: string; fields: string[] } {
  const [surface = c.element, ...props] = c.element.split('/properties/');
  const fromPath = props.length ? [props.map(unescapePointer).join('.')] : [];
  const quoted = [...c.text.matchAll(/[`'"]([A-Za-z_$][\w$./-]*)[`'"]/g)]
    .map((m) => (m[1] ?? '').replace(/\//g, '.'))
    .filter((f) => f.length > 0 && !OPERATION.test(f));
  if (c.kind === 'added' || INPUT.test(c.check ?? '') || /\brequest\b/i.test(c.text)) {
    return { surface, fields: [] };
  }
  return { surface, fields: [...new Set([...fromPath, ...(fromPath.length ? [] : quoted)])] };
}

// a field matches on its last segment, because a consumer records `issue.status` where the contract says `data/status`: a looser match over-reports a break and never under-reports one
const readsField = (used: readonly string[], field: string) =>
  used.some((u) => u === field || leaf(u) === leaf(field));

const GRAPHQL_PATH =
  /^((?:Query|Mutation|Subscription)\.[_A-Za-z]\w*)((?:\.[_A-Za-z]\w*)*)(?:\(([_A-Za-z]\w*)\))?$/;
const ROOT_PREFIX = /^(?:(?:Query|Mutation|Subscription)\.|(?:query|mutation|subscription)\s+)/;
const opName = (s: string) => s.replace(ROOT_PREFIX, '');

// a GraphQL change names the operation it reaches and the field path under it (`Query.products.variants.price`); an argument on the operation itself binds every caller of it, one on a nested field only the callers that select that field
function graphqlShape(c: ImpactChange): { surface: string; fields: string[] } | null {
  if (!c.check?.startsWith('graphql-')) return null;
  const m = GRAPHQL_PATH.exec(c.element);
  if (!m) return null;
  const [, surface = '', rest = '', arg] = m;
  const path = rest.slice(1);
  if (c.kind === 'added' && !arg) return { surface, fields: [] };
  return { surface, fields: path ? [path] : [] };
}

// a consumer names what it reads as `operation.field` (`products.title`, with or without its root type); a path under another operation never matches, and a bare field matches on its last segment like any other contract
function readsGraphqlField(used: readonly string[], op: string, field: string): boolean {
  return used.some((raw) => {
    const u = opName(raw);
    if (u.startsWith(`${op}.`)) {
      const rest = u.slice(op.length + 1);
      return rest === field || leaf(rest) === leaf(field);
    }
    return !u.includes('.') && leaf(u) === leaf(field);
  });
}

function graphqlBreak(
  link: ImpactLink,
  c: ImpactChange,
  shape: { surface: string; fields: string[] },
): ImpactBreak | null {
  const op = opName(shape.surface);
  const atOp = (s: string) => opName(s) === op || opName(s).startsWith(`${op}.`);
  const outside = link.outsideContract.filter(atOp);
  const sites = link.callSites.filter((s) => atOp(s.operation));
  const usesOp = sites.length > 0 || link.fieldsUsed.some(atOp);
  const read = shape.fields.filter((f) => readsGraphqlField(link.fieldsUsed, op, f));
  const contractHit =
    shape.fields.length === 0 ? usesOp : read.length > 0 && (usesOp || link.callSites.length === 0);
  if (!contractHit && outside.length === 0) return null;
  return {
    element: c.element,
    check: c.check ?? null,
    text: c.text,
    fields: contractHit ? read : [],
    callSites: sites.length ? sites : contractHit ? [...link.callSites] : [],
    outsideContract: outside,
  };
}

// outside-contract surface is in every check (Hyrum's law): the consumer declared no fields for it, so any breaking change at that surface breaks it whatever field it names
function breakOf(link: ImpactLink, c: ImpactChange): ImpactBreak | null {
  const graphql = graphqlShape(c);
  if (graphql) return graphqlBreak(link, c, graphql);
  const { surface, fields } = shapeOf(c);
  const whole = WHOLE.has(surface);
  const outside = link.outsideContract.filter((o) => whole || o === surface);
  const sites = link.callSites.filter((s) => whole || s.operation === surface);
  const surfaceKnown = whole || sites.length > 0 || link.callSites.length === 0;
  const read = fields.filter((f) => readsField(link.fieldsUsed, f));
  const contractHit =
    fields.length === 0
      ? whole || sites.length > 0 || link.fieldsUsed.includes(surface)
      : surfaceKnown && read.length > 0;
  if (!contractHit && outside.length === 0) return null;
  return {
    element: c.element,
    check: c.check ?? null,
    text: c.text,
    fields: contractHit ? read : [],
    callSites: sites.length ? sites : contractHit ? [...link.callSites] : [],
    outsideContract: outside,
  };
}

/** Each removal among `changes` that takes away a field the link reads, at whatever level the differ put it. */
export function fieldsRemovedFor(
  link: ImpactLink,
  changes: readonly ImpactChange[],
): ImpactBreak[] {
  return changes
    .filter((c) => c.kind === 'removed')
    .map((c) => breakOf(link, c))
    .filter((b): b is ImpactBreak => b !== null && b.fields.length > 0);
}

export function linkImpact(
  versioning: Versioning,
  version: string,
  measured: ImpactMeasurement | null,
  link: ImpactLink,
): LinkImpact {
  const base = {
    link: link.id,
    consumer: link.consumer,
    module: link.module,
    pinnedVersion: link.pinnedVersion,
  };
  if (compareVersions(versioning, link.pinnedVersion, version) >= 0) {
    return { ...base, verdict: 'passes', reason: 'built-against', breaks: [] };
  }
  if (!measured) return { ...base, verdict: 'breaks', reason: 'unmeasured', breaks: [] };
  const breaks = measured.changes
    .filter((c) => c.level === 'breaking')
    .map((c) => breakOf(link, c))
    .filter((b): b is ImpactBreak => b !== null);
  return breaks.length
    ? { ...base, verdict: 'breaks', reason: 'touched', breaks }
    : { ...base, verdict: 'passes', reason: 'no-breaking-change-touches', breaks: [] };
}

// a consumer that declares consumption and holds no link has nothing to be checked against, so it is owed the notice as unmapped rather than dropped
export function recipientsOf(
  declared: readonly string[],
  impacts: readonly LinkImpact[],
): Recipient[] {
  const byConsumer = new Map<string, LinkImpact[]>();
  for (const i of impacts) byConsumer.set(i.consumer, [...(byConsumer.get(i.consumer) ?? []), i]);
  const out: Recipient[] = [];
  for (const consumer of new Set([...declared, ...byConsumer.keys()])) {
    const mine = byConsumer.get(consumer) ?? [];
    const broken = mine.filter((i) => i.verdict === 'breaks');
    if (mine.length === 0) out.push({ consumer, reason: 'unmapped', links: [] });
    else if (broken.length) {
      const reason = broken.every((i) => i.reason === 'unmeasured') ? 'unmeasured' : 'breaks';
      out.push({ consumer, reason, links: broken.map((i) => i.link) });
    }
  }
  return out.sort((a, b) => a.consumer.localeCompare(b.consumer));
}

/**
 * Whether a breaking version owes a consumer an upgrade item, weighed against what its links to the
 * contract record (ISS-1135, FB-580: admin-api-v1 14.0.0 to 16.0.0 each broke only operations
 * catalog-api never calls, and each drafted an item its master answered "no upgrade needed"):
 * `touched`, naming each breaking entry and the recorded call sites and fields it reaches; owed too
 * where no link records its call sites (`unlinked`, `unrecorded`) or nothing measured the version
 * (`unmeasured`), each saying so; not owed where no breaking entry reaches anything a link records.
 */
export type UpgradeOwed =
  | { owed: true; why: 'touched'; breaks: ImpactBreak[] }
  | { owed: true; why: 'unlinked' | 'unrecorded' | 'unmeasured' }
  | { owed: false; links: string[] };

const recordsNothing = (l: ImpactLink) =>
  l.callSites.length === 0 && l.fieldsUsed.length === 0 && l.outsideContract.length === 0;

export function upgradeOwed(
  versioning: Versioning,
  version: string,
  measured: ImpactMeasurement | null,
  links: readonly ImpactLink[],
): UpgradeOwed {
  if (links.length === 0) return { owed: true, why: 'unlinked' };
  if (links.some(recordsNothing)) return { owed: true, why: 'unrecorded' };
  const impacts = links.map((l) => linkImpact(versioning, version, measured, l));
  const breaks = impacts.flatMap((i) => i.breaks);
  if (breaks.length > 0) return { owed: true, why: 'touched', breaks };
  if (impacts.some((i) => i.reason === 'unmeasured')) return { owed: true, why: 'unmeasured' };
  return { owed: false, links: links.map((l) => l.id) };
}

const UNWEIGHED: Record<Exclude<UpgradeOwed, { owed: false }>['why'], string> = {
  touched: "It reaches what this project's links to it record:",
  unlinked:
    'No link of this project to it records the calls it makes, so every breaking entry is owed a check against its code:',
  unrecorded:
    'A link of this project to it records no call site or field, so every breaking entry is owed a check against its code:',
  unmeasured:
    'Nothing measured this version against what its links record, so every breaking entry is owed a check against its code:',
};

/** What a consumer's upgrade item says of the breaking entries: those its links reach, and where, or all of them and why. */
export function upgradeWords(
  owed: Exclude<UpgradeOwed, { owed: false }>,
  breaking: readonly { element: string; text: string }[],
): { lead: string; entries: string[] } {
  if (owed.why !== 'touched') {
    return { lead: UNWEIGHED[owed.why], entries: breaking.map((c) => `${c.element}: ${c.text}`) };
  }
  return {
    lead: UNWEIGHED.touched,
    entries: owed.breaks.map((b) => {
      const at = [
        ...b.callSites.map((c) => `${c.operation} at ${callSiteAt(c)}`),
        ...b.fields.map((f) => `field \`${f}\``),
        ...b.outsideContract.map((o) => `${o}, outside the contract`),
      ];
      return `${b.element}: ${b.text}${at.length > 0 ? ` (reaches ${at.join('; ')})` : ''}`;
    }),
  };
}
