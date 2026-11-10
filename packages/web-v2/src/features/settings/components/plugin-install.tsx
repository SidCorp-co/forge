// The one command that installs the forge plugin on a machine, beside the tokens it takes.
import { useState } from "react";
import { Button, PageSection, PageSectionBody, SectionTitle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { pluginInstallCommand } from "@/lib/utils/runner-commands";

export function PluginInstall() {
  const [copied, setCopied] = useState(false);
  const t = useCopy();
  const command = pluginInstallCommand();
  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-3">{t("settings.plugin.title")}</SectionTitle>
        <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2">
          <code className="min-w-0 break-words font-mono text-13 text-fg">{command}</code>
          <Button
            variant="ghost"
            size="sm"
            icon={copied ? "check" : "link"}
            className="min-h-11"
            onClick={() =>
              void navigator.clipboard?.writeText(command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? t("settings.mcp.copied") : t("settings.agents.copy")}
          </Button>
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
