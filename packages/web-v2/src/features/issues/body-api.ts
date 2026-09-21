
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
