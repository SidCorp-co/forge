// What a project must tell the autonomous driver skill about itself.
//
// The staged pipeline solved per-project specificity by FORKING skills: every
// project that built differently got its own copy of forge-code, and the copies
// drifted from the original the day they were made. Autonomous mode runs ONE
// driver skill for every project — `issue-flow`, from Forge's own plugin repo
// github.com/SidCorp-co/forge-plugin — so the difference has to live in data.
//
// That data is `knowledge_entries` (ISS-1048; it was `agentConfig.projectFacts`
// until migration 0254). This file adds the only thing the store was missing: a
// DECLARED list of which entries the driver cannot run without, so "this project
// is ready to run autonomous" is a question with an answer.
//
// The list is COMPUTED from what the project declares rather than fixed, which
// is what stops "not declared" and "does not apply" looking alike. A project
// with no repository is not missing its build commands; it has no build. A
// project whose `releaseModel` is `none` is not missing a release procedure; it
// has no release step. Both were reported as gaps until this file computed
// them, on every project that would never run either.
//
// Design: docs/proposals/agent-driven-pipeline.md

import type { ReleaseModel } from '../db/schema.js';

export interface KnowledgeObligation {
  /** `knowledge_entries.slug`, fetched by the driver with `forge_knowledge`. */
  slug: string;
  /** What the agent uses it for. Rendered to the operator when it is missing. */
  role: string;
  /** The declaration that makes this owed. Rendered so a gap says WHY it is one. */
  because: string;
}

/** What the contract is a function of. Every field is a project column. */
export interface ProjectDeclarations {
  repoPath: string | null;
  repoUrl: string | null;
  releaseModel: ReleaseModel;
}

/**
 * A project declares a repository when EITHER column carries a non-empty string
 * after trimming. Both are independently nullable and neither has a minimum
 * length, so a URL-only project and a path-only project both have a repository,
 * and a project holding whitespace in both has none.
 */
export function declaresRepository(p: ProjectDeclarations): boolean {
  return (p.repoPath ?? '').trim().length > 0 || (p.repoUrl ?? '').trim().length > 0;
}

/**
 * The knowledge entries this project owes, given what it declares. Empty is a
 * real answer: a project with no repository and no release model owes nothing,
 * and asking it for build commands is asking it about a build it does not have.
 */
// cm:guard owed means "a phase cannot finish without it", never "nice to have". Everything that was optional in the old six-key contract — merge-target, deploy-policy, reproduction, done-means — is an ordinary knowledge entry now: found if it exists, absent without ceremony. A contract carries what a step cannot run without.
export function requiredProjectKnowledge(p: ProjectDeclarations): KnowledgeObligation[] {
  const owed: KnowledgeObligation[] = [];
  if (declaresRepository(p)) {
    owed.push({
      slug: 'build-commands',
      role: 'how to build this project, so a step can prove the branch compiles',
      because: 'this project declares a repository',
    });
    owed.push({
      slug: 'test-commands',
      role: 'how to run the tests a verdict rests on — a verdict with no test run is an opinion',
      because: 'this project declares a repository',
    });
  }
  if (p.releaseModel !== 'none') {
    owed.push({
      slug: 'release-procedure',
      role: 'how a release is performed here, so the release agent does not invent one',
      because: `this project declares releaseModel: ${p.releaseModel}`,
    });
  }
  return owed;
}

/**
 * The owed entries this project has not written. Empty means the contract is
 * answered. `present` is every non-archived slug the project holds, whatever
 * its injection setting — an entry set to `none` still answers the contract,
 * because the contract is about the text existing and not about delivery.
 */
export function missingProjectKnowledge(
  p: ProjectDeclarations,
  present: Iterable<string>,
): KnowledgeObligation[] {
  const held = new Set(present);
  return requiredProjectKnowledge(p).filter((o) => !held.has(o.slug));
}
