// The `/api/body/preview` read. It touches no row.
//
// It runs the SAME `prepareBody` a save runs, so the pane draws the bytes that
// would be stored and reports the refusal that would be answered.

import type { BodyNode } from "@forge/contracts";
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
  preview: (raw: string, format?: "markdown" | "html") =>
    apiClient<BodyPreview>("/body/preview", {
      method: "POST",
      body: JSON.stringify(format ? { raw, format } : { raw }),
    }),
};
