export const workflowHref = (slug: string, flow: string) =>
  `/projects/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(flow)}`;
