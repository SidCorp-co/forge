export const WORKFLOWS_LIST = "workflows";

export const workflowsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/workflows`;

export const workflowHref = (slug: string, flow: string) =>
  `/projects/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(flow)}`;
