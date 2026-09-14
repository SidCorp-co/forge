/**
 * The shape of the plugin's reader, declared here because the plugin ships plain
 * `.mjs` with no types of its own.
 */
// cm:guard this file DESCRIBES and never decides: a field added here that the plugin does not return, or a narrowing this file invents, is the server deciding a rule while looking like it is reading one (ISS-1006). It is checked by `plugin-shape.test.ts` against what the real module returns, not by tsc.
declare module 'forge-plugin/plugin/src/tracker/issue-shape.mjs' {
  /** One way a body missed its shape: what was read, what the shape wants, the one command that clears it. */
  export interface PluginGap {
    readonly read: string;
    readonly wants: string;
    readonly clear: string;
  }

  export interface PluginShape {
    readonly gaps: readonly PluginGap[];
    /** The line a filing that was accepted still earns, or null. */
    readonly said: string | null;
  }

  export function shapeOf(
    filing: {
      title?: string | null;
      body?: string | null;
      kind?: string | null;
      complexity?: string | null;
    },
    options?: { everySection?: boolean },
  ): PluginShape;

  /** The plugin's own renderer. Null where the body earned no gap. */
  export function shapeRefusal(shape: PluginShape): string | null;
}
