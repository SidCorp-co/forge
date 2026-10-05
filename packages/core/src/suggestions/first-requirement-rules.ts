// Workflow project-onboarding steps `requirements` and `suggested`: a requirement drafted against a
// journey design links only approved designs of the project, and one is suggested per journey.

import type { SuggestionRefusal } from '@forge/contracts/suggestions';

export interface DesignFact {
  id: string;
  flow: string;
  designStatus: string | null;
}

export interface FirstRequirementFacts {
  target: { type: string; id: string };
  /** `payload.designs` as parsed; undefined when the payload names none. */
  named: readonly string[] | undefined;
  /** Every design the target and `named` resolve to in the project, the rest being unknown. */
  designs: readonly DesignFact[];
  /** A requirement_draft already proposed or accepted on this journey, if any. */
  journeyTwin: { id: string; status: string } | null;
}

/** The designs a first requirement links: its journey first, then the others it serves, once each. */
export function linkedDesignIds(targetId: string, named: readonly string[] | undefined): string[] {
  return [...new Set([targetId, ...(named ?? [])])];
}

export function firstRequirementRefusals(f: FirstRequirementFacts): SuggestionRefusal[] {
  if (f.target.type !== 'workflow') {
    return f.named?.length
      ? [
          {
            code: 'SUGGESTION_PAYLOAD_INVALID',
            path: '/payload/designs',
            detail:
              'designs are named only on a requirement_draft that targets a journey design (workflow); one on an issue is drafted from that issue alone.',
          },
        ]
      : [];
  }
  const byId = new Map(f.designs.map((d) => [d.id, d]));
  const refusals: SuggestionRefusal[] = [];
  for (const id of linkedDesignIds(f.target.id, f.named)) {
    const path = id === f.target.id ? '/target' : `/payload/designs/${f.named?.indexOf(id) ?? 0}`;
    const design = byId.get(id);
    if (!design) {
      refusals.push({
        code: 'SUGGESTION_DESIGN_UNKNOWN',
        path,
        detail: `this project holds no design ${id}; name the approved designs the requirement serves by their id.`,
      });
    } else if (design.designStatus !== 'approved') {
      refusals.push({
        code: 'SUGGESTION_DESIGN_NOT_APPROVED',
        path,
        detail: `design ${design.flow} reads ${design.designStatus ?? 'undrafted'}, not approved; a first requirement is drafted only from approved designs.`,
      });
    }
  }
  if (f.journeyTwin) {
    refusals.push({
      code: 'SUGGESTION_JOURNEY_SUGGESTED',
      path: '/target',
      detail: `suggestion ${f.journeyTwin.id} (${f.journeyTwin.status}) already drafts a requirement for this journey; one is suggested per journey, so revise that one instead.`,
    });
  }
  return refusals;
}
