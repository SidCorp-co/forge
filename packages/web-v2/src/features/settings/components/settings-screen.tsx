"use client";

import {
  PageContainer,
  PageTitle,
  ScreenTabs,
  type TabItem,
} from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { AgentsTab } from "@/features/agent-accounts/components/agents-tab";
import { OrgsTab } from "@/features/orgs/components/orgs-tab";
import { AccountTab } from "./account-tab";
import { McpTab } from "./mcp-tab";
import { NotificationsTab } from "./notifications-tab";
import { TokensTab } from "./tokens-tab";

const TABS = [
  { value: "account", label: "Account" },
  { value: "orgs", label: "Organizations" },
  { value: "agents", label: "Agents" },
  { value: "tokens", label: "API Tokens" },
  { value: "mcp", label: "MCP" },
  { value: "notifications", label: "Notifications" },
] as const satisfies TabItem[];
type SettingsTab = (typeof TABS)[number]["value"];
const TAB_VALUES = TABS.map((t) => t.value);

export function SettingsScreen() {
  const [tab, setTab] = useTabParam<SettingsTab>(TAB_VALUES, "account");

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTabs
        tabs={[...TABS]}
        value={tab}
        onChange={(v) => setTab(v as SettingsTab)}
        header={<PageTitle>Settings</PageTitle>}
      />

      <PageContainer>
        <div className="max-w-4xl">
          {tab === "account" && <AccountTab />}
          {tab === "orgs" && <OrgsTab />}
          {tab === "agents" && <AgentsTab />}
          {tab === "tokens" && <TokensTab />}
          {tab === "mcp" && <McpTab />}
          {tab === "notifications" && <NotificationsTab />}
        </div>
      </PageContainer>
    </div>
  );
}
