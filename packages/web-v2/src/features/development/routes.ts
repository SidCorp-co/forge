import { ecosystemRoutes } from "@/features/ecosystem/routes";
import { issueHref, issuesHref } from "@/features/issues/routes";
import type { OverviewNeed } from "./types";

const project = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

export const developmentOverviewHref = (slug: string) => `${project(slug)}/overview`;

export const releasesHref = (slug: string) => `${project(slug)}/releases`;

export const needHref = (slug: string, n: Pick<OverviewNeed, "kind" | "ref">): string =>
  n.kind === "issue" ? issueHref(slug, n.ref) : n.kind === "release" ? releasesHref(slug) : ecosystemRoutes.contracts(slug);

export const needPeekHref = (slug: string, n: Pick<OverviewNeed, "kind" | "ref">): string =>
  n.kind === "issue" ? `${issuesHref(slug)}?peek=${encodeURIComponent(n.ref)}` : needHref(slug, n);
