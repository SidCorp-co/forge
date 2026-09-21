declare module 'forge-plugin/plugin/src/resolve/visibility.mjs' {
  export const VERB_NAMES: readonly string[];
  export function withheldForJob(verbs: readonly string[]): string[];
}
