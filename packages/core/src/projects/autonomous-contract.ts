export interface KnowledgeObligation {
  /** `knowledge_entries.slug`, fetched by the driver with `forge_knowledge`. */
  slug: string;
  /** What the agent uses it for. Rendered to the operator when it is missing. */
  role: string;
  /** The declaration that makes this owed. Rendered so a gap says WHY it is one. */
  because: string;
}

/** What the contract is a function of: the repository column and the project document's production. */
export interface ProjectDeclarations {
  repoUrl: string | null;
  /** The production environment's name, or null where the project document declares none. */
  production: string | null;
}

export function declaresRepository(p: ProjectDeclarations): boolean {
  return (p.repoUrl ?? '').trim().length > 0;
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
  if (p.production !== null) {
    owed.push({
      slug: 'release-procedure',
      role: 'how a release is performed here, so the release agent does not invent one',
      because: `this project's document declares production environment \`${p.production}\``,
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
