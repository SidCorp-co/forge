"use client";

// cm:guard tab state lives in `?tab=` through the shared `useTabParam` hook and never in component state, because a tab nobody can link to cannot be put in a bug report, a runbook or a message to a colleague — every other tabbed screen here is reachable that way and one that is not reads as broken (ISS-349). The 'Sessions' tab is deliberately absent rather than disabled: a tab that opens on nothing is a promise the product does not keep (ISS-299).
import { PageContainer, ScreenTabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { AgentsTab } from "@/features/agent-accounts/components/agents-tab";
import { OrgsTab } from "@/features/orgs/components/orgs-tab";
import { AccountTab } from "./account-tab";
import { McpTab } from "./mcp-tab";
import { NotificationsTab } from "./notifications-tab";
import { TokensTab } from "./tokens-tab";

const TAB_VALUES = ["account", "orgs", "agents", "tokens", "mcp", "notifications"] as const;
type SettingsTab = (typeof TAB_VALUES)[number];

const TABS: TabItem[] = [
  { value: "account", label: "Account" },
  { value: "orgs", label: "Organizations" },
  { value: "agents", label: "Agents" },
  { value: "tokens", label: "API Tokens" },
  { value: "mcp", label: "MCP" },
  { value: "notifications", label: "Notifications" },
];

// cm:guard the SHELL is the shared wide column and the form inside it is capped separately: the strip has to line up with every other screen's, while a text input stretched to 1700px is unusable. Cap the shell instead and this screen stops matching the ones beside it.
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
