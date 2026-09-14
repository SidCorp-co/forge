/**
 * The plugin's verb surface, declared here because the plugin ships plain
 * `.mjs` with no types of its own.
 */
// cm:guard this file DESCRIBES and never decides: the verb names and the job arithmetic are the plugin's, read at runtime; a name added here that the plugin does not export is the server inventing a verb (ISS-1009).
declare module 'forge-plugin/plugin/src/resolve/visibility.mjs' {
  /** Every verb this CLI has, in help order. */
  export const VERB_NAMES: readonly string[];
  /** The verbs a job does NOT offer — what `forge doctor --job <name>` writes as `withheld`. */
  export function withheldForJob(verbs: readonly string[]): string[];
}
