"use client";

// Workspace-tier Settings (`/v2/settings`). User-scoped sub-tabs: Account, API
// Tokens, MCP, Notifications. The unimplemented 'Sessions' tab is intentionally
// dropped (ISS-299 AC). Tab state lives in the URL hash so a tab is linkable.
import { useEffect, useState } from "react";
import { Tabs, type TabItem } from "@/design";
import { AccountTab } from "./account-tab";
import { McpTab } from "./mcp-tab";
import { NotificationsTab } from "./notifications-tab";
import { TokensTab } from "./tokens-tab";

const TABS: TabItem[] = [
  { value: "account", label: "Account" },
  { value: "tokens", label: "API Tokens" },
  { value: "mcp", label: "MCP" },
  { value: "notifications", label: "Notifications" },
];

const VALID = new Set(TABS.map((t) => t.value));

export function SettingsScreen() {
  const [tab, setTab] = useState("account");

  // Hydrate from / sync to the URL hash so a tab is bookmarkable.
  useEffect(() => {
    const fromHash = window.location.hash.replace("#", "");
    if (VALID.has(fromHash)) setTab(fromHash);
  }, []);

  function select(value: string) {
    setTab(value);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${value}`);
    }
  }

  return (
    <div className="mx-auto w-full min-h-dvh max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">Settings</h1>
        <p className="fg-body-sm mt-1">Your account, tokens, and notifications.</p>
      </header>

      <div className="mb-6 overflow-x-auto">
        <Tabs tabs={TABS} value={tab} onChange={select} />
      </div>

      {tab === "account" && <AccountTab />}
      {tab === "tokens" && <TokensTab />}
      {tab === "mcp" && <McpTab />}
      {tab === "notifications" && <NotificationsTab />}
    </div>
  );
}
