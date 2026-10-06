export const modulesHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/modules`;

export const moduleHref = (slug: string, module: string) => `${modulesHref(slug)}/${encodeURIComponent(module)}`;

export const MODULES_LIST = "modules";
