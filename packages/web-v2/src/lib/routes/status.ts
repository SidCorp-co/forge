export const statusReportHref = (slug: string, days?: number) =>
  `/projects/${encodeURIComponent(slug)}/status${days ? `?days=${days}` : ""}`;
