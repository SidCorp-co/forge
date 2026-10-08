import type { QueryKey } from "@tanstack/react-query";
import { NotificationsMenu } from "@/design";
import { NotificationsBell } from "@/features/notifications/components/notifications-bell";
import { NotificationsTab } from "@/features/settings/components/notifications-tab";
import { SettingsScreen } from "@/features/settings/components/settings-screen";
import { Seeded } from "./vi-chrome-requirements";
import type { ChromeScreen } from "./vi-chrome-screens";

// The notifications bell panel and the Account preferences page, for the vi walking test. Content is
// placeholder words.

const P = "p1";
const AT = "2026-10-07T10:00:00Z";
const project = { id: P, slug: "hop", name: "Hop", role: "admin", orgId: null };
const noop = () => {};

const delivery = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  notificationId: id,
  projectId: P,
  type: "feedback_message",
  kind: "task",
  tier: "ticket",
  title: "Tieu de",
  body: "Noi dung dai",
  readAt: null,
  groupKey: null,
  resolvedNotice: false,
  members: 1,
  openMembers: 1,
  severity: "info",
  issueId: null,
  secondaryIssueId: null,
  agentSessionId: null,
  createdAt: AT,
  subject: { kind: "issue", key: "ISS-4", id: "i4" },
  project: { slug: "hop", name: "Hop" },
  line: "Dong mot",
  ...over,
});
const bellSeed = (): [QueryKey, unknown][] => [
  [["projects"], [project]],
  [
    ["notifications", "open"],
    {
      pages: [
        {
          items: [
            delivery("n1"),
            delivery("n2", { type: "pipeline_wedge", secondaryIssueId: "i5", severity: "warning" }),
            delivery("n3", { type: "issue_stranded", members: 4, openMembers: 0, readAt: AT }),
            delivery("n4", { type: "requirement_delivered", resolvedNotice: true }),
          ],
          totalCount: 40,
        },
      ],
      pageParams: [1],
    },
  ],
  [["notifications-open"], { count: 40 }],
  [["invitations-pending"], [{ kind: "project", ref: "r1", name: "Kho", inviterEmail: "lan@vi.test", role: "member", expiresAt: AT, createdAt: AT }]],
];

const notifications = () => (
  <Seeded data={bellSeed()}>
    <NotificationsBell open onClose={noop} anchor={{ current: document.body }} />
    <NotificationsMenu items={[]} onMarkAllRead={noop} onOpenAll={noop} />
    <NotificationsMenu items={[]} error onRetry={noop} />
    <NotificationsMenu items={[]} loading />
  </Seeded>
);

const settingsSeed = (): [QueryKey, unknown][] => [
  [["settings", "preferences"], { theme: "system", language: "vi", notifyOnMention: true }],
  [["settings", "assistant-preferences"], { answerStyle: "concise", assistantInstructions: "Ngan gon" }],
  [
    ["settings", "preference-changes"],
    [
      { id: "c1", field: "answer_style", newValue: "concise", oldValue: "default", changedBy: "person", changedAt: AT },
      { id: "c2", field: "assistant_instructions", newValue: null, oldValue: "x", changedBy: "assistant", changedAt: AT },
    ],
  ],
  [["settings", "notifications", 1], { items: [delivery("n1"), delivery("n3", { members: 4, openMembers: 2, readAt: AT })], totalCount: 2 }],
];

const account = () => (
  <Seeded data={settingsSeed()}>
    <SettingsScreen />
  </Seeded>
);
const notificationSettings = () => (
  <Seeded data={settingsSeed()}>
    <NotificationsTab />
  </Seeded>
);

export const SCREENS: ChromeScreen[] = [
  { name: "Notifications", render: notifications },
  { name: "Account preferences", render: account },
  { name: "Notification settings", render: notificationSettings },
];
