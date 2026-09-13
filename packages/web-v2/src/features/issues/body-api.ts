// The two `/api/body` reads (ISS-967). Neither touches a row.
//
// `components` is the registry itself, and its only caller since the composer's
// insert menu was cut on 2026-09-14 is the Pipeline settings tab, whose
// `requireComponent` select must offer exactly the roots core will accept — so
// there is still no component list in web to drift from it.
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
