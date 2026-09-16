import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const google: ProviderModule = {
  provider: "google",
  label: "Google Sheets",
  icon: "rows",
  // cm:edge contract -> packages/core/src/integrations/rotation.ts — the whole service-account file
  // is the rotating unit; the PEM inside it is not, and this name is what says so on the web side.
  secretField: "serviceAccountJson",
  secretPlaceholder: "the service-account JSON file, whole",
  drillable: true,
  agentPathKind: "core-mediated",
  mcpServerName: null,
  multiBinding: false,
  target: (config) => text(config, "clientEmail"),
  section: () => import("./section").then((m) => ({ default: m.GoogleSection })),
  connectionSection: null,
  connectionNote:
    "The service account's identity is read back out of the key by a successful Test. The spreadsheet a project defaults to is set per project, under project settings → Integrations.",
};
