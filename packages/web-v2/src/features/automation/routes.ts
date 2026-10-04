export const AUTOMATION_LIST = "automation";

export const AUTOMATION_TABS = ["schedules", "fires", "reports"] as const;
export type AutomationTab = (typeof AUTOMATION_TABS)[number];

export const automationListHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/automation`;

export const automationTabHref = (slug: string, tab: AutomationTab) =>
  tab === "schedules" ? automationListHref(slug) : `${automationListHref(slug)}?tab=${tab}`;

export const scheduleHref = (slug: string, id: string) => `${automationListHref(slug)}/schedules/${encodeURIComponent(id)}`;

export const fireHref = (slug: string, id: string) => `${automationListHref(slug)}/fires/${encodeURIComponent(id)}`;

export const reportHref = (slug: string, id: string) => `${automationListHref(slug)}/reports/${encodeURIComponent(id)}`;

export const sessionHref = (slug: string, sessionId: string) =>
  `/projects/${encodeURIComponent(slug)}/agents/${encodeURIComponent(sessionId)}`;
