import { PipelineTab } from "@/features/project-settings/components/pipeline-tab";
import { PluginsSection } from "@/features/project-settings/components/plugins-section";
import { ReleaseSection } from "@/features/project-settings/components/release-section";
import { releaseReadinessKey } from "@/features/project-config/hooks";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { Seeded } from "./vi-chrome-requirements";

// The release card and the plugins list of a project's pipeline settings, and the gate every project
// page stands behind. Names and sentences core wrote are placeholder words (they stay as written).

const P = "p-rel";
const AT = "2026-10-07T08:00:00.000Z";
const readiness = (over: Record<string, unknown> = {}) => ({
  hasReleaseGate: true,
  defaultBranch: "dev",
  production: { environment: "production", deploysFrom: "main", bindingId: "b1", trigger: "on-request" },
  promotions: [{ from: "dev", to: "main", via: "merge" }],
  targetUndeclared: false,
  targetUndeclaredReason: null,
  providers: ["prov-a"],
  releaseRunnerLabel: "runner-1",
  rollback: "Quay lai ban truoc",
  rollbackMode: "manual",
  hasVerify: true,
  verifySources: ["environment"],
  declarationRead: true,
  channelsRead: true,
  blockers: [],
  warnings: [],
  gaps: [],
  ...over,
});
const projectRow = (plugins: unknown[]) => ({ id: P, slug: "hop", name: "Hop", agentConfig: { plugins }, updatedAt: AT });
const wrap = (readinessValue: unknown, plugins: unknown[], children: React.ReactNode) => (
  <Seeded data={[[releaseReadinessKey(P), readinessValue], [["project", P], projectRow(plugins)]]}>{children}</Seeded>
);

export const SETTINGS_AGENTS_SCREENS = [
  { name: "Release card · gated", render: () => wrap(readiness(), [], <ReleaseSection projectId={P} slug="hop" />) },
  {
    name: "Release card · rollback and triggers",
    render: () =>
      wrap(
        readiness({
          rollbackMode: "coolify-image",
          production: { environment: "production", deploysFrom: null, bindingId: "b1", trigger: "on-land" },
          promotions: [{ from: "dev", to: "main", via: "cherry-pick" }],
          hasVerify: false,
          verifySources: ["declared-unusable"],
          releaseRunnerLabel: null,
        }),
        [],
        <ReleaseSection projectId={P} slug="hop" />,
      ),
  },
  {
    name: "Release card · provider trigger unrepresentable",
    render: () =>
      wrap(
        readiness({
          rollbackMode: "unrepresentable",
          rollback: null,
          production: { environment: "production", deploysFrom: "main", bindingId: "b1", trigger: "provider" },
          verifySources: ["none"],
        }),
        [],
        <ReleaseSection projectId={P} slug="hop" />,
      ),
  },
  {
    name: "Release card · blockers warnings gaps",
    render: () =>
      wrap(
        readiness({
          hasReleaseGate: false,
          production: null,
          promotions: [],
          providers: [],
          rollbackMode: null,
          rollback: null,
          hasVerify: false,
          verifySources: [],
          releaseRunnerLabel: null,
          blockers: [
            { code: "A", message: "Chua co runner.", evaluated: true },
            { code: "B", message: "Khong doc duoc.", evaluated: false },
          ],
          warnings: [{ code: "W", message: "Chay tay." }],
          gaps: ["build-commands", "test-commands", "release-procedure", "release-target", "rollback", "rollback-prose", "verify-probes"],
        }),
        [],
        <ReleaseSection projectId={P} slug="hop" />,
      ),
  },
  {
    name: "Release card · target undeclared",
    render: () =>
      wrap(
        readiness({ hasReleaseGate: false, production: null, targetUndeclared: true, targetUndeclaredReason: "Thieu dich den." }),
        [],
        <ReleaseSection projectId={P} slug="hop" />,
      ),
  },
  {
    name: "Release card · unread",
    render: () => wrap(readiness({ declarationRead: false, channelsRead: false, hasReleaseGate: false }), [], <ReleaseSection projectId={P} slug="hop" />),
  },
  { name: "Release card · loading", render: () => <Seeded data={[]}><ReleaseSection projectId={P} slug="hop" /></Seeded> },
  {
    name: "Pipeline settings tab",
    render: () => wrap(readiness(), [{ marketplace: "sid", name: "forge", pinnedRef: "v1" }], <PipelineTab projectId={P} canEdit slug="hop" />),
  },
  {
    name: "Plugins · list with an invalid row",
    render: () =>
      wrap(readiness(), [{ marketplace: "sid", name: "forge", pinnedRef: "v1" }, { marketplace: "", name: "", pinnedRef: null }], <PluginsSection projectId={P} canEdit />),
  },
  { name: "Plugins · read only", render: () => wrap(readiness(), [{ marketplace: "sid", name: "forge", pinnedRef: null }], <PluginsSection projectId={P} canEdit={false} />) },
  { name: "Plugins · empty", render: () => wrap(readiness(), [], <PluginsSection projectId={P} canEdit />) },
  { name: "Plugins · loading", render: () => <Seeded data={[]}><PluginsSection projectId={P} canEdit /></Seeded> },
  {
    name: "Project gate · loading",
    render: () => (
      <Seeded data={[]}>
        <ProjectGate label="Hop">{() => null}</ProjectGate>
      </Seeded>
    ),
  },
  {
    name: "Project gate · not found",
    render: () => (
      <Seeded data={[[["projects"], []]]}>
        <ProjectGate label="Hop">{() => null}</ProjectGate>
      </Seeded>
    ),
  },
];
