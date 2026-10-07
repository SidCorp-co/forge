"use client";

// Settings → API Tokens. List + create (one-time plaintext reveal) + revoke.
import { useState } from "react";
import { Button, SectionTitle, SlideOver } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useRevokeToken, useTokens } from "../hooks";
import type { PatToken, PatTokenCreated } from "../types";
import { TokenCreateForm } from "./token-create-form";
import { TokenList } from "./token-list";

export function TokensTab() {
  const tokensQ = useTokens();
  const projectsQ = useProjects();
  const revoke = useRevokeToken();
  const [revealed, setRevealed] = useState<PatTokenCreated | null>(null);
  const t = useCopy();

  const projectsById = new Map((projectsQ.data ?? []).map((p) => [p.id, p]));
  const levelOf = (token: PatToken) =>
    token.boundProjectId
      ? t("settings.tokens.levelProject", { slug: projectsById.get(token.boundProjectId)?.slug ?? token.boundProjectId.slice(0, 8) })
      : t("settings.tokens.levelUser");

  return (
    <div className="space-y-6">
      <TokenCreateForm
        tokens={tokensQ.data?.tokens ?? []}
        // The menu the door will accept, served beside the list so the form
        // cannot offer a name the create call would be refused for.
        menu={tokensQ.data?.menu ?? null}
        onCreated={setRevealed}
      />
      <div>
        <SectionTitle className="fg-h3 mb-3">{t("settings.tokens.yours")}</SectionTitle>
        <TokenList
          tokensQ={tokensQ}
          levelOf={levelOf}
          onRevoke={(id) => revoke.mutate(id)}
          pending={revoke.isPending}
        />
      </div>
      <SlideOver open={!!revealed} onClose={() => setRevealed(null)} title={t("settings.tokens.created")}>
        {revealed && (
          <TokenReveal
            token={revealed}
            boundSlug={revealed.boundProjectId ? projectsById.get(revealed.boundProjectId)?.slug : undefined}
            onDone={() => setRevealed(null)}
          />
        )}
      </SlideOver>
    </div>
  );
}

function TokenReveal({
  token,
  boundSlug,
  onDone,
}: {
  token: PatTokenCreated;
  boundSlug: string | undefined;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const t = useCopy();

  async function copyPlaintext() {
    try {
      await navigator.clipboard.writeText(token.plaintext);
      toast({ title: t("settings.agents.copied"), tone: "success" });
    } catch {
      toast({ title: t("settings.agents.copyFailed"), description: t("settings.tokens.copyByHand"), tone: "error" });
    }
  }

  return (
    <div className="space-y-4">
      <p className="fg-body-sm text-muted">{t("settings.tokens.copyNow")}</p>
      {token.boundProjectId && (
        <p className="fg-body-sm text-muted">
          {t("settings.tokens.boundLead")}{" "}
          <span className="font-medium text-fg">{boundSlug ?? t("settings.tokens.selectedProject")}</span>.{" "}
          {t("settings.tokens.boundHeaderLead")} <code className="font-mono">X-Forge-Project-Slug</code>{" "}
          {t("settings.tokens.boundHeaderTail")}
        </p>
      )}
      <div className="rounded-md border border-line bg-sunken p-3">
        <code className="block break-all font-mono text-13 text-fg">{token.plaintext}</code>
      </div>
      <div className="flex gap-3">
        <Button variant="primary" icon="check" onClick={copyPlaintext} className="min-h-11">
          {t("settings.tokens.copyToClipboard")}
        </Button>
        <Button variant="secondary" onClick={onDone} className="min-h-11">
          {t("settings.tokens.done")}
        </Button>
      </div>
    </div>
  );
}
