"use client";

import {
  PageContainer,
  PageTitle,
  ScreenTabs,
  type TabItem,
} from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { AgentsTab } from "@/features/agent-accounts/components/agents-tab";
import { OrgsTab } from "@/features/orgs/components/orgs-tab";
import { AccountTab } from "./account-tab";
import { McpTab } from "./mcp-tab";
import { NotificationsTab } from "./notifications-tab";
import { TokensTab } from "./tokens-tab";

const TABS = [
  { value: "account", label: "shell.settings.tab.account" },
  { value: "orgs", label: "shell.settings.tab.orgs" },
  { value: "agents", label: "shell.settings.tab.agents" },
  { value: "tokens", label: "shell.settings.tab.tokens" },
  { value: "mcp", label: "shell.settings.tab.mcp" },
  { value: "notifications", label: "shell.settings.tab.notifications" },
] as const satisfies Array<{ value: string; label: ProductCopyKey }>;
type SettingsTab = (typeof TABS)[number]["value"];
const TAB_VALUES = TABS.map((t) => t.value);

export function SettingsScreen() {
  const [tab, setTab] = useTabParam<SettingsTab>(TAB_VALUES, "account");
  const t = useCopy();
  const tabs: TabItem[] = TABS.map((it) => ({ value: it.value, label: t(it.label) }));

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTabs
        tabs={tabs}
        value={tab}
        onChange={(v) => setTab(v as SettingsTab)}
        header={<PageTitle>{t("nav.settings")}</PageTitle>}
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
