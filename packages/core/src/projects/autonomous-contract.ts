import { chainShipsNothing, type ReleaseChain } from './release-chain.js';

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
  releaseChain: ReleaseChain;
}

export function declaresRepository(p: ProjectDeclarations): boolean {
  return (p.repoPath ?? '').trim().length > 0 || (p.repoUrl ?? '').trim().length > 0;
}

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
  if (!chainShipsNothing(p.releaseChain)) {
    owed.push({
      slug: 'release-procedure',
      role: 'how a release is performed here, so the release agent does not invent one',
      because: `this project declares a release chain of ${p.releaseChain.length} branch(es), ending at ${p.releaseChain[p.releaseChain.length - 1]?.branch}`,
    });
  }
  return owed;
}

export function missingProjectKnowledge(
  p: ProjectDeclarations,
  present: Iterable<string>,
): KnowledgeObligation[] {
  const held = new Set(present);
  return requiredProjectKnowledge(p).filter((o) => !held.has(o.slug));
}
