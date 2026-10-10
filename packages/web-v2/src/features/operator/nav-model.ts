import type { IconName } from "@/design";
import type { OperatorSectionKey } from "./types";

interface OperatorNavItem {
  key: OperatorSectionKey;
  href: string;
  icon: IconName;
}

export const OPERATOR_SECTIONS: OperatorNavItem[] = [
  { key: "overview", href: "/admin", icon: "grid" },
  { key: "alerts", href: "/admin/alerts", icon: "alert" },
  { key: "fleet", href: "/admin/fleet", icon: "server" },
  { key: "pipeline", href: "/admin/pipeline", icon: "pipeline" },
  { key: "growth", href: "/admin/growth", icon: "dollar" },
  { key: "mcp-logs", href: "/admin/mcp-logs", icon: "list" },
];

/** Longest-prefix match so `/admin` never wins over a more specific sub-route
 *  like `/admin/alerts`. Unknown `/admin/*` sub-routes fall back to overview. */
export function activeSectionFromPath(pathname: string): OperatorSectionKey {
  const path = pathname.replace(/\/+$/, "") || "/admin";
  let best: OperatorNavItem | null = null;
  for (const item of OPERATOR_SECTIONS) {
    const matches = path === item.href || path.startsWith(`${item.href}/`);
    if (matches && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.key ?? "overview";
}

export function hrefForSection(key: OperatorSectionKey): string {
  return OPERATOR_SECTIONS.find((s) => s.key === key)?.href ?? "/admin";
}
