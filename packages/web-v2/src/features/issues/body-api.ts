// The two `/api/body` reads a composer needs (ISS-967). Neither touches a row.
//
// `components` is the registry itself — the insert menu offers what core will
// accept, so there is no component list in web to drift from it.
// `preview` runs the SAME `prepareBody` a save runs, so the pane draws the
// bytes that would be stored and reports the refusal that would be answered.

import type { BodyComponentDescriptor, BodyNode } from "@forge/contracts";
import { apiClient } from "@/lib/api/client";

export interface BodyPreview {
  body: string;
  format: string;
  template: string | null;
  warnings: string[];
  text: string;
  nodes: BodyNode[] | null;
}

export const bodyApi = {
  components: () =>
    apiClient<{ items: BodyComponentDescriptor[] }>("/body/components").then((r) => r.items),

  preview: (raw: string, format?: "markdown" | "html") =>
    apiClient<BodyPreview>("/body/preview", {
      method: "POST",
      body: JSON.stringify(format ? { raw, format } : { raw }),
    }),
};

/**
 * The markup an insert writes: the opening tag with every required attribute
 * present but empty, then one line per required slot.
 */
// cm:guard emit EVERY required attribute and slot, even empty. A skeleton missing one produces a body the kernel refuses, and a menu whose output is refused is worse than no menu — the author has no way to tell their typing from the template's omission.
export function componentSkeleton(
  spec: BodyComponentDescriptor,
  byName: Map<string, BodyComponentDescriptor>,
): string {
  const attrs = spec.attrs
    .map((a) => ` ${a.name}="${a.values?.[0] ?? ""}"`)
    .join("");
  if (spec.raw) return `<${spec.name}${attrs}>\n\n</${spec.name}>`;
  const slots = spec.slots
    .filter((s) => s.required || !s.repeat)
    .map((s) => {
      const child = byName.get(s.component);
      const childAttrs = (child?.attrs ?? [])
        .filter((a) => a.required)
        .map((a) => ` ${a.name}="${a.values?.[0] ?? ""}"`)
        .join("");
      return `  <${s.component}${childAttrs}></${s.component}>`;
    })
    .join("\n");
  return slots
    ? `<${spec.name}${attrs}>\n${slots}\n</${spec.name}>`
    : `<${spec.name}${attrs}>\n\n</${spec.name}>`;
}
