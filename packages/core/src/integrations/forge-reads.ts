// What an adapter must know about Forge's own rows, handed in by the process entry at boot, so no
// adapter imports the module that owns them (ADR 0008: an adapter imports no domain or kernel).

interface ForgeReads {
  /** The repository the project document declares (`source.git.repository`), or null. */
  declaredRepository(projectId: string): Promise<string | null>;
  /** The issue a branch name refers to on a project, or null. */
  issueForHeadRef(projectId: string, headRef: string): Promise<string | null>;
}

let provided: ForgeReads | null = null;

export function provideForgeReads(reads: ForgeReads): void {
  provided = reads;
}

export function forgeReads(): ForgeReads {
  if (!provided) {
    throw new Error(
      'integrations: no Forge reads were provided, so an adapter cannot read a declared repository or link a branch to an issue; the process entry calls provideForgeReads before it serves',
    );
  }
  return provided;
}
