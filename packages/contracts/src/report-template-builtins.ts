// The built-in report templates, as data. Each names the registered queries it runs, the blocks it
// draws over their frames and the narrative slots a model fills from those runs alone. Adding one is
// an entry here; `validateTemplate` (report-templates.ts) is the only judge of it, and no template
// holds code. A project's own template, saved later, passes the same validator.

import { type ReportTemplate, ReportTemplateSchema } from "./report-templates.js";

const slots = (summary: string, risks: string, recommendations: string): ReportTemplate["narrative"] => [
  { slot: "summary", guidance: summary, maxWords: 80 },
  { slot: "risks", guidance: risks, maxWords: 80 },
  { slot: "recommendations", guidance: recommendations, maxWords: 80 },
];

const PROGRESS = {
  id: "progress",
  version: 1,
  title: "Progress",
  params: { state: { type: "string", label: "Only requirements in this state" } },
  queries: [
    { as: "progress", query: "progress-by-requirement", params: { state: { param: "state" } } },
    { as: "coverage", query: "criteria-coverage", params: {} },
  ],
  layout: [
    { kind: "chart", as: "progress", title: "Criteria proven per requirement", variant: "bar", x: "key", y: ["criteriaProven", "criteriaTotal"] },
    { kind: "status-list", as: "progress", title: "Requirements", ref: "key", status: "state" },
    { kind: "table", as: "progress", title: "Issues behind each requirement", columns: ["key", "title", "shipped", "awaitingRelease", "toDo"] },
    { kind: "table", as: "coverage", title: "Criteria and their proof", columns: ["requirement", "criterion", "verdict", "issues"] },
  ],
  narrative: slots(
    "Say where the work stands: how many requirements and how far their criteria are proven.",
    "Name the requirements with unproven criteria or issues still to do, as the runs show them.",
    "Say what to take next, from the unproven criteria and the issues still to do.",
  ),
} satisfies ReportTemplate;

const RELEASE = {
  id: "release",
  version: 1,
  title: "Release readiness",
  params: {},
  queries: [
    { as: "release", query: "release-readiness", params: {} },
    { as: "progress", query: "progress-by-requirement", params: {} },
  ],
  layout: [
    {
      kind: "kpi",
      as: "release",
      title: "The next release",
      figures: [
        { field: "total", label: "Issues" },
        { field: "shipped", label: "Shipped" },
        { field: "awaitingRelease", label: "Awaiting release" },
        { field: "toDo", label: "To do" },
      ],
    },
    { kind: "table", as: "release", title: "Where it stands", columns: ["release", "state", "requirements", "turnWho", "turnAct", "behindRelease"] },
    { kind: "status-list", as: "progress", title: "Requirements", ref: "key", status: "state" },
  ],
  narrative: slots(
    "Say whether the next release is ready and what it still waits on.",
    "Name what could hold it back: issues still to do, and whose turn it is.",
    "Say what to do next so it ships, and who does it.",
  ),
} satisfies ReportTemplate;

const ROADMAP = {
  id: "roadmap",
  version: 1,
  title: "Roadmap",
  params: { lane: { type: "string", label: "Only this lane" } },
  queries: [{ as: "roadmap", query: "roadmap-eta", params: { lane: { param: "lane" } } }],
  layout: [
    { kind: "timeline", as: "roadmap", title: "When each requirement lands", label: "key", p50: "p50At", p85: "p85At", lane: "lane" },
    { kind: "table", as: "roadmap", title: "Forecast", columns: ["lane", "key", "title", "state", "p50At", "p85At", "basis"] },
  ],
  narrative: slots(
    "Say what lands when, from the forecast dates.",
    "Name the requirements whose p85 date is far behind their p50, or that have no basis.",
    "Say what to move or cut, from the forecast.",
  ),
} satisfies ReportTemplate;

/** Built to the schema at load: a template that stops being valid data stops the process, by name. */
export const BUILTIN_REPORT_TEMPLATES: readonly ReportTemplate[] = [PROGRESS, RELEASE, ROADMAP].map(
  (t) => ReportTemplateSchema.parse(t),
);

export const builtinReportTemplate = (id: string): ReportTemplate | undefined =>
  BUILTIN_REPORT_TEMPLATES.find((t) => t.id === id);
