/** The shareable page of one workflow: the owner opens it to review a design. */
export const workflowHref = (slug: string, flow: string) =>
  `/projects/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(flow)}`;
