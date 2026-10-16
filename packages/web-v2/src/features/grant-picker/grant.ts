// What a person picks a token's reach with, on the token form and on an MCP client's consent page: a
// ready grant (read only, read and write, full) or the keys chosen area by area. The keys a pick
// holds are the menu's own (`GET /api/pat` → menu), so what is sent is exactly what was sent before
// the picker had presets.
import { PAT_GRANT_AREAS, type PatGrantPreset } from "@forge/contracts/pat-areas";

/** The permission menu core serves. */
export interface GrantMenu {
  permissions: string[];
  accountOnly: string[];
  explicit: string[];
  full: string;
}

/** "" until chosen; `full` sends the menu's full name alone, `named` sends `permissions`. */
export interface GrantChoice {
  grantMode: "" | "full" | "named";
  permissions: string[];
}

/** Every key a pick may hold: an account permission reaches no project, so a fenced grant offers none. */
export function offeredKeys(menu: GrantMenu, fenced: boolean): string[] {
  const keys = [...menu.permissions, ...menu.explicit];
  return fenced ? keys.filter((k) => !menu.accountOnly.includes(k)) : keys;
}

/**
 * The keys a ready grant names. Read and read-and-write name route groups only: a named act (an
 * approval, a moderation) is held only where a person ticks it.
 */
export function presetKeys(menu: GrantMenu, preset: Exclude<PatGrantPreset, "full">, fenced: boolean): string[] {
  const routes = menu.permissions.filter((k) => !(fenced && menu.accountOnly.includes(k)));
  return preset === "read" ? routes.filter((k) => k.endsWith(":read")) : routes;
}

export function choosePreset(menu: GrantMenu, preset: PatGrantPreset, fenced: boolean): GrantChoice {
  return preset === "full"
    ? { grantMode: "full", permissions: [] }
    : { grantMode: "named", permissions: presetKeys(menu, preset, fenced) };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));

/** The ready grant a choice is, or null when its keys were chosen by hand. */
export function presetOf(choice: GrantChoice, menu: GrantMenu, fenced: boolean): PatGrantPreset | null {
  if (choice.grantMode === "full") return "full";
  if (choice.grantMode !== "named") return null;
  const held = choice.permissions.filter((k) => offeredKeys(menu, fenced).includes(k));
  if (held.length === 0) return null;
  if (sameSet(held, presetKeys(menu, "read", fenced))) return "read";
  if (sameSet(held, presetKeys(menu, "readWrite", fenced))) return "readWrite";
  return null;
}

/** A key turned on or off by hand: the choice becomes a named one, whatever ready grant it was. */
export function toggleKey(choice: GrantChoice, key: string): GrantChoice {
  const permissions = choice.grantMode === "named" ? choice.permissions : [];
  return {
    grantMode: "named",
    permissions: permissions.includes(key) ? permissions.filter((k) => k !== key) : [...permissions, key],
  };
}

export interface GrantArea {
  /** An area of `PAT_GRANT_AREAS`, or `other` for a key a newer core serves that this build places nowhere. */
  id: string;
  keys: string[];
}

/** The offered keys by area, in the areas' order; an area offering nothing is left out. */
export function areasOf(offered: string[]): GrantArea[] {
  const placed = new Set<string>(PAT_GRANT_AREAS.flatMap((a) => [...a.keys]));
  const areas: GrantArea[] = PAT_GRANT_AREAS.map((a) => ({
    id: a.id,
    keys: (a.keys as readonly string[]).filter((k) => offered.includes(k)),
  }));
  const other = offered.filter((k) => !placed.has(k));
  if (other.length > 0) areas.push({ id: "other", keys: other });
  return areas.filter((a) => a.keys.length > 0);
}
