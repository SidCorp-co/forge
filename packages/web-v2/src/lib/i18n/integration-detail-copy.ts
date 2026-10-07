import { copyOr } from "./product-copy";
import type { Rule, Vars } from "./standing-rule";

// What core says about one integration row's health (`integration-door/status-service.ts`, each
// adapter's `neverCheckedDetail`). A provider's name, a host and an adapter's own failure words after
// the dash stay as core wrote them; `integration-detail-copy.test.ts` holds each pattern to the
// sentence core really builds.

const exact = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const raw = (g: Record<string, string>): Vars => ({ ...g });
const COST = "Forge cannot read its commits, merge into it or compare branches, so a release cannot tell what already shipped";
const STATUS = "(?<status>[a-z_]+)";
/** A health value in the reader's words, as the connection's state family names it. */
const health = (g: Record<string, string>, language: string): Vars => ({ ...g, status: copyOr(language, `common.state.connection.${g.status}`, g.status ?? "") });

export const INTEGRATION_DETAIL: Rule[] = [
  { re: new RegExp("^no (?<provider>.+) integration configured$"), key: "integrations.detail.noneConfigured", vars: raw },
  { re: exact("integration disabled"), key: "integrations.detail.disabled" },
  { re: new RegExp(`^last health: ${STATUS}$`), key: "integrations.detail.lastHealth", vars: health },
  { re: new RegExp(`^last health: ${STATUS} — (?<detail>.+)$`), key: "integrations.detail.lastHealthWhy", vars: health },
  { re: exact("never test-connected"), key: "integrations.detail.neverTested" },
  { re: exact("never health-checked"), key: "integrations.row.neverChecked" },
  { re: exact("Never checked — run Test connection to probe the App installation and the repository."), key: "integrations.detail.neverGithub" },
  { re: exact("Never checked — run Test connection to probe the token and the project webhook."), key: "integrations.detail.neverGitlab" },
  { re: exact("the project document declares no repository"), key: "integrations.detail.noRepository" },
  {
    re: exact(`a local path no host serves: ${COST}. Its head is read from a runner's bound checkout; declare the hosted repository to read the rest`),
    key: "integrations.detail.localPath",
  },
  { re: new RegExp(`^no source host binding reaches (?<host>\\S+): ${COST}\\. Connect (?<provider>.+) to fix it$`), key: "integrations.detail.unreachedConnect", vars: raw },
  { re: new RegExp(`^no source host binding reaches (?<host>\\S+): ${COST}\\. Bind a source host connection serving \\S+ to fix it$`), key: "integrations.detail.unreachedBind", vars: raw },
  { re: new RegExp(`^the (?<provider>.+) binding that reaches it is switched off: ${COST}$`), key: "integrations.detail.switchedOff", vars: raw },
  { re: new RegExp(`^read through (?<provider>.+) — last health: ${STATUS}$`), key: "integrations.detail.readThrough", vars: health },
  { re: new RegExp("^read through (?<provider>.+) — never health-checked$"), key: "integrations.detail.readThroughNever", vars: raw },
];
