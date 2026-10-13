// Old `?tab=` links go to the surface that owns that content now; an unknown value is named, not guessed at.
export type LegacyTab =
  | { kind: "none" }
  | { kind: "redirect"; href: string; onIssues: boolean }
  | { kind: "unknown"; value: string };

/** `modules` sets `groupBy=module` over any `groupBy` the link held; `list` and `modules` stay on Issues. */
export function legacyTab(slug: string, search: string): LegacyTab {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab === null) return { kind: "none" };

  if (tab === "board") return { kind: "redirect", href: `/projects/${slug}/pipeline`, onIssues: false };
  if (tab === "insights") return { kind: "redirect", href: `/projects/${slug}`, onIssues: false };

  if (tab === "list" || tab === "modules") {
    params.delete("tab");
    if (tab === "modules") params.set("groupBy", "module");
    const qs = params.toString();
    return { kind: "redirect", href: `/projects/${slug}/issues${qs ? `?${qs}` : ""}`, onIssues: true };
  }

  return { kind: "unknown", value: tab };
}
