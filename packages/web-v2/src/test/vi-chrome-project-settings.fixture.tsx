import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { AdvancedSection } from "@/features/project-settings/components/advanced-tab";
import { DeliverySection } from "@/features/project-settings/components/delivery-section";
import { GeneralSection } from "@/features/project-settings/components/general-section";
import { LabelsTab } from "@/features/project-settings/components/labels-tab";
import { MembersTab } from "@/features/project-settings/components/members-tab";
import { ModulesTab } from "@/features/project-settings/components/modules-tab";
import { ProjectSettingsScreen } from "@/features/project-settings/components/project-settings-screen";
import type { ProjectDetail } from "@/features/projects/types";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { GATE_SENTENCES, gateOf } from "./vi-chrome-shared";
import { Seeded } from "./vi-chrome-requirements";

// Project settings for the vi walking test: each section with values in every field, a release state
// carrying a normal state, a problem and every kind of thing still to write down, and the technical
// view. A branch, an environment's name, a repository, an email and a document key stay as written.

const P = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-07T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const DOC = {
  $schema: "https://forge.sidcorp.co/schemas/project-v1.json",
  version: 1,
  project: { id: P, slug: "hop", name: "Hop", description: "Cua hang in theo yeu cau" },
  source: { type: "git", git: { repository: "github.com/acme/hop", defaultBranch: "dev", branches: ["dev", "main"] } },
  workspace: { isolation: "worktree" },
  validation: { gate: { type: "github-check", name: "ci-passed" } },
  environments: {
    prod: {
      tier: "production",
      deploysFrom: "main",
      deployment: { binding: B, trigger: "on-request" },
      url: "https://hop.example.com",
      verification: { runtime: [{ type: "http", url: "https://hop.example.com/api/version", path: "commit", identifies: "source" }] },
    },
    beta: { tier: "staging", deployment: { mode: "external" } },
  },
  promotions: [{ from: "dev", to: "main", via: "merge" }],
  rollback: { strategy: "redeploy-previous" },
  plan: { approval: { required: true } },
  release: { approval: { required: true } },
  requirements: { readinessGate: "warn" },
  feedback: { verifyWindowDays: 7 },
  sensitiveData: "redact",
  contentLanguage: "vi",
  keepTermsInEnglish: ["checkout"],
  execution: { plugin: { source: "SidCorp-co/forge-plugin", ref: "a".repeat(40) } },
};

const POLICY = {
  $schema: "https://forge.sidcorp.co/schemas/policy-v1.json",
  version: 1,
  qa: "independent",
  intake: { mode: "auto" },
  permissions: { driver: { deny: [] } },
  states: { open: { model: "opus", permissions: "driver" } },
};

const BINDING = {
  $schema: "https://forge.sidcorp.co/schemas/binding-v1.json",
  version: 1,
  id: B,
  role: "deploy",
  connection: "33333333-3333-4333-8333-333333333333",
  target: { provider: "coolify", label: "web", applications: [{ label: "web", resourceUuid: "abcdefghijklmnopqrst" }] },
};

const gate = (code: string) => {
  const g = GATE_SENTENCES.find((s) => s.code === code);
  if (!g) throw new Error(`no gate sentence for ${code}`);
  return gateOf(g, "person");
};

const READINESS = {
  hasReleaseGate: true,
  defaultBranch: "dev",
  production: { environment: "prod", deploysFrom: "main", bindingId: B, trigger: "on-request" },
  promotions: [{ from: "dev", to: "main", via: "merge" }],
  targetUndeclared: false,
  targetUndeclaredReason: null,
  providers: ["coolify"],
  releaseRunnerLabel: null,
  rollback: null,
  rollbackMode: "coolify-image",
  hasVerify: false,
  verifySources: ["none"],
  declarationRead: true,
  channelsRead: true,
  blockers: [],
  warnings: [],
  gates: [gate("RELEASE_ROSTER_EMPTY"), gate("RELEASE_POOL_EMPTY"), gate("RELEASE_RUNNER_PREFERENCE_UNMET")],
  gaps: ["build-commands", "test-commands", "release-procedure", "release-target", "verify-probes", "rollback", "rollback-prose"],
};

const LIST = [{ id: P, slug: "hop", name: "Hop", orgId: "o1", orgName: "Acme", orgIsPersonal: false, createdBy: "u1", role: "admin", orgRole: "owner", archivedAt: null, createdAt: ago(9000) }];
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], devicePool: [], agentConfig: { plugins: [{ marketplace: "SidCorp-co/forge-plugin", name: "forge", pinnedRef: null }] }, archivedAt: null } as unknown as ProjectDetail;

const declared = (document: unknown, revision = 6) => ({ declared: true, revision, document });

const queries = (): [QueryKey, unknown][] => [
  [["projects", "all"], LIST],
  [["project", P], DETAIL],
  [["project", P, "config"], declared(DOC)],
  [["project", P, "policy"], declared(POLICY, 2)],
  [["project", P, "bindings"], { bindings: [declared(BINDING, 1)], unrepresentable: [{ id: "b9", provider: "sentry", role: "service", revision: 1, reason: "x" }], returned: 1 }],
  [["project", P, "release-readiness"], READINESS],
  [["project", P, "members"], [{ userId: "u1", email: "an@example.com", role: "admin", createdAt: ago(900) }, { userId: "u2", email: "binh@example.com", role: "viewer", createdAt: ago(800) }]],
  [["project", P, "invitations"], [{ email: "chi@example.com", role: "member", expiresAt: ago(-60), createdAt: ago(60), inviterEmail: "an@example.com", expired: true }]],
  [["orgs"], [{ id: "o1", name: "Acme", slug: "acme", role: "owner", isPersonal: false }, { id: "o2", name: "Beta", slug: "beta", role: "admin", isPersonal: false }]],
  [["orgs", "o1", "members"], [{ userId: "u1", email: "an@example.com", role: "owner" }, { userId: "u3", email: "dung@example.com", role: "member" }]],
  [["project", P, "labels"], [
    { id: "m1", name: "Thanh toan", color: "#336699", kind: "module", parentId: null, slug: "thanh-toan", knowledgeEntryId: null, description: null },
    { id: "m2", name: "Gio hang", color: "#996633", kind: "module", parentId: "m1", slug: "gio-hang", knowledgeEntryId: null, description: "Mo ta" },
    { id: "l1", name: "khach-vip", color: "#aa3366", kind: "label", parentId: null, slug: null, knowledgeEntryId: null, description: null },
  ]],
  [["project", P, "testing-profiles"], { profiles: [{ ...declared({ $schema: "https://forge.sidcorp.co/schemas/testing-profile-v1.json", version: 1, id: "hop-beta", actors: { an: { role: "project-admin", password: "secret://hop-beta/an-password" } }, services: {}, limits: [] }, 1), profileId: "hop-beta" }], returned: 1 }],
  [["project", P, "secrets"], { secrets: [], returned: 0 }],
  [["project", P, "environment-state"], { revision: 6, environments: [{ environment: "beta", state: "unknown", evidence: "none", reason: { cause: "external", message: "x" } }] }],
  [["project", P, "config-effective"], { declared: true, revision: 6, device: null, undeclared: ["device-binding"], values: { "/workspace/isolation": { value: "worktree", from: "project", revision: 6 } } }],
];

const seeded = (ui: ReactElement) => <Seeded data={queries()}>{ui}</Seeded>;

/** A control found by its label in either language: the rail test draws each screen in en as well. */
const clickKey = (key: ProductCopyKey) => () => {
  const labels = [productCopy("vi")(key), productCopy("en")(key)];
  const el = [...document.querySelectorAll("button, a")].find((b) => labels.some((l) => b.textContent?.trim().startsWith(l.split("{")[0] ?? l)));
  if (!el) throw new Error(`nothing to open labelled ${key}`);
  fireEvent.click(el);
};

export const SCREENS = [
  {
    name: "Project settings · shell and General",
    render: () => {
      window.history.replaceState(null, "", "/projects/hop/settings");
      return seeded(<ProjectSettingsScreen slug="hop" />);
    },
  },
  { name: "Project settings · General", render: () => seeded(<GeneralSection project={DETAIL} canEdit />) },
  { name: "Project settings · People", render: () => seeded(<MembersTab projectId={P} canEdit />) },
  { name: "Project settings · Work, modules", render: () => seeded(<ModulesTab projectId={P} canEdit />) },
  { name: "Project settings · Work, labels", render: () => seeded(<LabelsTab projectId={P} canEdit />) },
  { name: "Project settings · Delivery", render: () => seeded(<DeliverySection project={DETAIL} canEdit />), act: clickKey("settings.project.release.gap.write") },
  { name: "Project settings · Advanced", render: () => seeded(<AdvancedSection project={DETAIL} canEdit />) },
  { name: "Project settings · read only", render: () => seeded(<DeliverySection project={DETAIL} canEdit={false} />) },
];
