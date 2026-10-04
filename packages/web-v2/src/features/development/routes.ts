const project = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

export const developmentOverviewHref = (slug: string) => `${project(slug)}/overview`;
