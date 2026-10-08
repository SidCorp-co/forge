// What the public guide corpus says about its own extent. Core serves the guides defined in its
// registry; the forge CLI serves a second set, the methods that drive work, on the plugin's own
// release clock, and core neither holds nor can read them. So every public surface that lists
// guides says so here, in one place, and names the CLI-served ones as a pointer the CLI overrides.
//
// No flags and no tool names: the CLI describes itself, and a flag copied here would go stale on
// some release with nothing saying so.

export interface CliServedGuide {
  slug: string;
  covers: string;
}

/**
 * Pointer, not a list to rely on. The plugin owns these guides and adds or retires one on its own
 * clock; `forge guide` on a box is the answer, and `CORPUS_SCOPE.authority` says so wherever this
 * list is shown.
 */
export const CLI_SERVED_GUIDES: readonly CliServedGuide[] = [
  { slug: 'dispatch', covers: 'running one wave of delegated issue work' },
  { slug: 'issue-flow', covers: 'taking one issue from its title to deployed code' },
  { slug: 'qa', covers: 'judging a change that has landed' },
  { slug: 'release-flow', covers: 'taking a landed change to a verified production deployment' },
  { slug: 'master', covers: "the resident master's pass over one project's board" },
  { slug: 'contract', covers: 'what each issue status is owed before it moves' },
  { slug: 'gate-review', covers: "profiling a project's gate and making it faster" },
  { slug: 'harness-eval', covers: 'judging the harness by its own numbers' },
];

export const CORPUS_SCOPE = {
  complete: false,
  listed:
    'The guides in this list are the ones Forge core serves, each also at /api/guides/<slug>.md.',
  elsewhere:
    'Not listed here: the method guides, which the forge CLI serves. They are not served by this host and are not an error to be missing from it.',
  reach:
    'On a machine with the forge CLI, `forge guide` lists every guide that CLI serves and `forge guide <slug>` prints one.',
  authority:
    "The CLI's own list is authoritative. The names below are a pointer taken when this core was built, and the plugin may add or retire a guide without this list moving.",
  cliServed: CLI_SERVED_GUIDES,
} as const;

/** The same statement as one paragraph, for a surface that carries prose and not a field. */
export function corpusScopeSentence(): string {
  return `${CORPUS_SCOPE.elsewhere} ${CORPUS_SCOPE.reach} ${CORPUS_SCOPE.authority}`;
}

/** The statement a refused slug carries: the likeliest reason it is absent is that the CLI serves it. */
export const NOT_SERVED_HERE_NOTE =
  'A method guide (running a wave, taking an issue to landed code, judging, releasing) is served by the forge CLI, not by this host: `forge guide` on a machine with the CLI lists them.';
