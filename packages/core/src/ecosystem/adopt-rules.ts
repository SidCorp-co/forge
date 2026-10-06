import { jsonPointer as pointer } from '../lib/refusal.js';
import { type MeasuredDiff, NOT_MEASURED_CHECK, TRUNCATED_CHECK } from './contract/diff.js';
import { fieldsRemovedFor, type ImpactChange, type ImpactLink } from './contract/impact.js';
import { compareVersions, type Versioning } from './contract/naming.js';
import { pinRefusals } from './pin-rules.js';
import type { EcosystemRefusal } from './refusals.js';

/** A recorded version as adopt reads it: its approval, the version it was measured against, what the differ said. */
export interface AdoptVersion {
  approval: string;
  previous: string | null;
  diff: Pick<MeasuredDiff, 'classification'> & { changes: readonly ImpactChange[] };
  elements: ReadonlySet<string> | null;
}

export interface AdoptWorld {
  /** `<provider slug>/<contract slug>`, as the consumption names it. */
  contract: string;
  version: string;
  versioning: Versioning;
  /** Each `consumes` entry of the consumer's interface that names `contract`, by its index. */
  consumed: readonly { index: number; builtAgainst: string }[];
  versions: ReadonlyMap<string, AdoptVersion>;
  /** The consumer's links to `contract` in the ecosystems it consumes it in. */
  links: readonly ImpactLink[];
}

export interface AdoptPlan {
  consumptions: { index: number; from: string }[];
  links: { id: string; module: string; from: string }[];
}

type AdoptCheck = { ok: true; plan: AdoptPlan } | { ok: false; refusals: EcosystemRefusal[] };

interface Pin {
  version: string;
  holder: string;
  path: string;
}

const pinsOf = (w: AdoptWorld): Pin[] => [
  ...w.consumed.map((c) => ({
    version: c.builtAgainst,
    holder: `the interface's consumption /consumes/${c.index}`,
    path: pointer(['consumes', c.index, 'builtAgainst']),
  })),
  ...w.links.map((l) => ({
    version: l.pinnedVersion,
    holder: `link ${l.id} (${l.module})`,
    path: pointer(['links', l.id, 'pinnedVersion']),
  })),
];

// the versions from `version` back along each one's `previous`, newest first: every version is measured against the one latest when it was recorded, so this is the one line of measurements that reaches an older pin
function chainFrom(w: AdoptWorld): string[] {
  const chain: string[] = [];
  let at: string | null = w.version;
  while (at !== null && w.versions.has(at) && !chain.includes(at)) {
    chain.push(at);
    at = w.versions.get(at)?.previous ?? null;
  }
  return chain;
}

// a step is additive only where a differ measured it and found nothing above info: a breaking measurement, an unknown one, a declared semantic change or a change no differ read all stop the adopt
function stepRefusal(w: AdoptWorld, step: string): EcosystemRefusal | null {
  const v = w.versions.get(step);
  if (!v) return null;
  const from = v.previous ?? 'nothing';
  if (v.diff.classification === 'breaking') {
    return {
      code: 'ADOPT_VERSION_BREAKING',
      path: '/version',
      detail: `${w.contract} ${step} is measured breaking against ${from}; adopt moves a consumer only across additive versions, so a breaking one is worked through its change notice and the consumer's own issue.`,
    };
  }
  const unread = v.diff.changes.some(
    (c) => c.check !== undefined && NOT_MEASURED_CHECK.test(c.check),
  );
  if (v.diff.changes.some((c) => c.check === TRUNCATED_CHECK)) {
    return {
      code: 'ADOPT_VERSION_UNMEASURED',
      path: '/version',
      detail: `${w.contract} ${step} measured more changes against ${from} than its record lists, so a removed field a link reads may be among the ones not listed; adopt moves a consumer only where every change between its pin and ${w.version} can be read.`,
    };
  }
  if (v.diff.classification !== 'non-breaking' || unread) {
    return {
      code: 'ADOPT_VERSION_UNMEASURED',
      path: '/version',
      detail: `${w.contract} ${step} is measured ${v.diff.classification} against ${from}, not non-breaking; adopt moves a consumer only where a differ measured every version between its pin and ${w.version} as additive.`,
    };
  }
  return null;
}

function versionRefusals(w: AdoptWorld, moving: readonly Pin[], chain: readonly string[]) {
  const out: EcosystemRefusal[] = [];
  const told = new Set<string>();
  for (const pin of moving) {
    const at = chain.indexOf(pin.version);
    if (at < 0) {
      out.push({
        code: 'ADOPT_VERSION_UNMEASURED',
        path: pin.path,
        detail: `no line of measured versions leads from ${pin.version}, which ${pin.holder} pins, to ${w.contract} ${w.version} (measured back to ${chain.at(-1) ?? w.version}); adopt moves a pin only across versions each measured against the one before it.`,
      });
      continue;
    }
    for (const step of chain.slice(0, at)) {
      if (told.has(step)) continue;
      told.add(step);
      const refusal = stepRefusal(w, step);
      if (refusal) out.push(refusal);
    }
  }
  return out;
}

// a field is gone where a measured removal between the link's pin and the version takes it, or where the field is an element the pinned version indexes and the version does not
function fieldRefusals(w: AdoptWorld, chain: readonly string[]): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  const target = w.versions.get(w.version)?.elements ?? null;
  for (const link of w.links) {
    const at = chain.indexOf(link.pinnedVersion);
    if (at <= 0) continue;
    const missing = new Map<string, string>();
    for (const step of chain.slice(0, at)) {
      for (const b of fieldsRemovedFor(link, w.versions.get(step)?.diff.changes ?? [])) {
        for (const f of b.fields)
          if (!missing.has(f)) missing.set(f, `${step} removed it: ${b.text}`);
      }
    }
    const pinned = w.versions.get(link.pinnedVersion)?.elements ?? null;
    for (const f of link.fieldsUsed) {
      if (target && pinned?.has(f) && !target.has(f) && !missing.has(f)) {
        missing.set(f, `${link.pinnedVersion} indexes it and ${w.version} does not`);
      }
    }
    for (const [field, why] of missing) {
      out.push({
        code: 'ADOPT_FIELD_MISSING',
        path: pointer(['links', link.id, 'fieldsUsed']),
        detail: `link ${link.id} (${link.module}) reads ${field}, which ${w.contract} ${w.version} no longer holds (${why}); adopt moves a link only where every field it uses is still in the version, so this link is re-checked against the code and written by hand.`,
      });
    }
  }
  return out;
}

/**
 * Whether a consumer may move its consumption of `contract`, and every link to it, to `version` in
 * one act (feedback-triage `breaking`): the version is approved, at or after every pin, measured
 * additive at each step from each pin, and still holds every field each moving link uses.
 */
export function checkAdopt(w: AdoptWorld): AdoptCheck {
  if (w.consumed.length === 0) {
    return {
      ok: false,
      refusals: [
        {
          code: 'ADOPT_CONTRACT_NOT_CONSUMED',
          path: '/contract',
          detail: `this project's interface consumes no contract ${w.contract}; adopt moves a declared consumption, so declare it in the interface first.`,
        },
      ],
    };
  }
  const approvals = new Map([...w.versions].map(([v, x]) => [v, x.approval]));
  const unpinnable = pinRefusals({
    ref: w.contract,
    version: w.version,
    versions: approvals,
    path: '/version',
    field: 'version',
  });
  if (unpinnable.length > 0) return { ok: false, refusals: unpinnable };
  const pins = pinsOf(w);
  const behind = pins
    .filter((p) => compareVersions(w.versioning, w.version, p.version) < 0)
    .map(
      (p): EcosystemRefusal => ({
        code: 'ADOPT_VERSION_BEHIND_PIN',
        path: p.path,
        detail: `${p.holder} pins ${w.contract} ${p.version}, after ${w.version}; adopt moves pins forward only, never back to an older version.`,
      }),
    );
  if (behind.length > 0) return { ok: false, refusals: behind };
  const moving = pins.filter((p) => compareVersions(w.versioning, w.version, p.version) > 0);
  const chain = chainFrom(w);
  const refusals = versionRefusals(w, moving, chain);
  if (refusals.length > 0) return { ok: false, refusals };
  const fields = fieldRefusals(w, chain);
  if (fields.length > 0) return { ok: false, refusals: fields };
  const moves = (v: string) => compareVersions(w.versioning, w.version, v) > 0;
  return {
    ok: true,
    plan: {
      consumptions: w.consumed
        .filter((c) => moves(c.builtAgainst))
        .map((c) => ({ index: c.index, from: c.builtAgainst })),
      links: w.links
        .filter((l) => moves(l.pinnedVersion))
        .map((l) => ({ id: l.id, module: l.module, from: l.pinnedVersion })),
    },
  };
}
