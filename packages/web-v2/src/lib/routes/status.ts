export const statusReportHref = (slug: string, days?: number) =>
  `/projects/${encodeURIComponent(slug)}/status${days ? `?days=${days}` : ""}`;

/** One kept report on the status page's History tab: where a sent report's notice and inbox row link. */
export const keptReportHref = (slug: string, reportId: string) =>
  `/projects/${encodeURIComponent(slug)}/status?tab=history&report=${encodeURIComponent(reportId)}`;
