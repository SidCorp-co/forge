"use client";

// Workspace-tier Settings (`/settings`). User-scoped sub-tabs: Account, API
// Tokens, MCP, Notifications. The unimplemented 'Sessions' tab is intentionally
// dropped (ISS-299 AC). Tab state lives in `?tab=` via the shared `useTabParam`
// hook (ISS-349) so a tab is linkable and the strip matches the other tabbed
// screens; the form body stays in a narrower reading column.
import { ScreenTabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { AccountTab } from "./account-tab";
import { McpTab } from "./mcp-tab";
import { NotificationsTab } from "./notifications-tab";
import { TokensTab } from "./tokens-tab";

const TAB_VALUES = ["account", "tokens", "mcp", "notifications"] as const;
type SettingsTab = (typeof TAB_VALUES)[number];

const TABS: TabItem[] = [
  { value: "account", label: "Account" },
  { value: "tokens", label: "API Tokens" },
  { value: "mcp", label: "MCP" },
  { value: "notifications", label: "Notifications" },
];

export function SettingsScreen() {
  const [tab, setTab] = useTabParam<SettingsTab>(TAB_VALUES, "account");

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTabs
        tabs={TABS}
        value={tab}
        onChange={(v) => setTab(v as SettingsTab)}
        header={
          <header className="mb-6">
            <h1 className="fg-h2">Settings</h1>
            <p className="fg-body-sm mt-1">Your account, tokens, and notifications.</p>
          </header>
        }
      />

      <div className="mx-auto w-full max-w-4xl px-4 pb-8 pt-6 sm:px-8">
        {tab === "account" && <AccountTab />}
        {tab === "tokens" && <TokensTab />}
        {tab === "mcp" && <McpTab />}
        {tab === "notifications" && <NotificationsTab />}
      </div>
    </div>
  );
}
