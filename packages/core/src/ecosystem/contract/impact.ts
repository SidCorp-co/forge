import type { CallSite } from '../link-schema.js';
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

export type LinkReason = 'no-breaking-change-touches' | 'built-against' | 'touched' | 'unmeasured';

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

// cm:why an added or newly required input binds every caller of the surface whatever it reads, so only a removed or changed property a consumer reads narrows the break to that consumer
// cm:why a change's element is `<operation>/properties/<a>/properties/<b>` from the schema differ, or an operation whose text quotes the property from oasdiff; the part before the first property is the surface, the properties are the fields
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

// cm:why a field matches on its last segment, because a consumer records `issue.status` where the contract says `data/status`: a looser match over-reports a break and never under-reports one
const readsField = (used: readonly string[], field: string) =>
  used.some((u) => u === field || leaf(u) === leaf(field));

const GRAPHQL_PATH =
  /^((?:Query|Mutation|Subscription)\.[_A-Za-z]\w*)((?:\.[_A-Za-z]\w*)*)(?:\(([_A-Za-z]\w*)\))?$/;
const ROOT_PREFIX = /^(?:(?:Query|Mutation|Subscription)\.|(?:query|mutation|subscription)\s+)/;
const opName = (s: string) => s.replace(ROOT_PREFIX, '');

// cm:why a GraphQL change names the operation it reaches and the field path under it (`Query.products.variants.price`); an argument on the operation itself binds every caller of it, one on a nested field only the callers that select that field
function graphqlShape(c: ImpactChange): { surface: string; fields: string[] } | null {
  if (!c.check?.startsWith('graphql-')) return null;
  const m = GRAPHQL_PATH.exec(c.element);
  if (!m) return null;
  const [, surface = '', rest = '', arg] = m;
  const path = rest.slice(1);
  if (c.kind === 'added' && !arg) return { surface, fields: [] };
  return { surface, fields: path ? [path] : [] };
}

// cm:why a consumer names what it reads as `operation.field` (`products.title`, with or without its root type); a path under another operation never matches, and a bare field matches on its last segment like any other contract
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

// cm:why outside-contract surface is in every check (Hyrum's law): the consumer declared no fields for it, so any breaking change at that surface breaks it whatever field it names
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

// cm:why a consumer that declares consumption and holds no link has nothing to be checked against, so it is owed the notice as unmapped rather than dropped
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
