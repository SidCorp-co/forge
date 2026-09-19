import { readTokenSources, resolveTokenAliases, themePalettes } from "./tokens.js";

export const THEME_OVERRIDE_DIRECTIVE =
  "Delete the declaration, or give the theme its own value. A block that restates the " +
  "value under it is indistinguishable from the rebinding that was forgotten, and an " +
  "unrebound token is silently the base theme's colour on a surface it never had.";

/**
 * Declarations a layered theme could drop without moving a colour. Compared after
 * `var()` is followed, so an alias landing on the value already in force is the
 * same no-op as a repeated literal.
 */
export function findRedundantOverrides({ tokenFile, block, tokenPattern, sources, themes } = {}) {
  const palettes = themePalettes({ themes, tokenFile, block, tokenPattern, sources });
  if (palettes.some(({ sources: from }) => from.length === 0 || from.some((one) => !one.file))) {
    throw new TypeError(
      "findRedundantOverrides needs { tokenFile }: the CSS file the design tokens are declared in.",
    );
  }

  const found = [];
  for (const { name, sources: layers } of palettes) {
    for (let depth = 1; depth < layers.length; depth += 1) {
      const under = resolveTokenAliases(readTokenSources(layers.slice(0, depth)));
      const over = resolveTokenAliases(readTokenSources(layers.slice(0, depth + 1)));
      const layer = layers[depth];
      for (const token of readTokenSources([layer]).keys()) {
        if (!under.has(token) || under.get(token) !== over.get(token)) continue;
        found.push({ theme: name, token, value: over.get(token), block: layer.block ?? null });
      }
    }
  }
  return found;
}
