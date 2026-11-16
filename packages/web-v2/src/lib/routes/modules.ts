export const modulesHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/modules`;

export const moduleHref = (slug: string, module: string) => `${modulesHref(slug)}/${encodeURIComponent(module)}`;

export const MODULES_LIST = "modules";

/** The module map's Capabilities branch across every module (ISS-1256): what the Agents tab was. */
export const capabilitiesHref = (slug: string) => `${modulesHref(slug)}?view=capabilities`;
