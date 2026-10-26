import { PROVIDER_LABELS } from "@forge/contracts/health-words";
import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const google: ProviderModule = {
  provider: "google",
  label: PROVIDER_LABELS.google,
  icon: "rows",
  secretField: "serviceAccountJson",
  secretPlaceholder: "the service-account JSON file, whole",
  previousKeyNote: "Forge keeps the previous key for 24 hours and signs in with it wherever Google refuses the new one.",
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
