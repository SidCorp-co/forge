"use client";

// Settings → API Tokens. List + create (one-time plaintext reveal) + revoke.
import { useState } from "react";
import { Button, SectionTitle, SlideOver } from "@/design";
import { useProjects } from "@/features/projects/hooks";
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

  const projectsById = new Map((projectsQ.data ?? []).map((p) => [p.id, p]));
  const levelOf = (t: PatToken) =>
    t.boundProjectId
      ? `Project: ${projectsById.get(t.boundProjectId)?.slug ?? t.boundProjectId.slice(0, 8)}`
      : "User-level";

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
        <SectionTitle className="fg-h3 mb-3">Your tokens</SectionTitle>
        <TokenList
          tokensQ={tokensQ}
          levelOf={levelOf}
          onRevoke={(id) => revoke.mutate(id)}
          pending={revoke.isPending}
        />
      </div>
      <SlideOver open={!!revealed} onClose={() => setRevealed(null)} title="Token created">
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

  async function copyPlaintext() {
    try {
      await navigator.clipboard.writeText(token.plaintext);
      toast({ title: "Copied to clipboard", tone: "success" });
    } catch {
      toast({ title: "Copy failed", description: "Select and copy the token manually.", tone: "error" });
    }
  }

  return (
    <div className="space-y-4">
      <p className="fg-body-sm text-muted">Copy this token now — it won&apos;t be shown again.</p>
      {token.boundProjectId && (
        <p className="fg-body-sm text-muted">
          This is a project-level token bound to{" "}
          <span className="font-medium text-fg">{boundSlug ?? "the selected project"}</span>. MCP
          clients can omit the <code className="font-mono">X-Forge-Project-Slug</code> header — calls
          resolve to this project automatically.
        </p>
      )}
      <div className="rounded-md border border-line bg-sunken p-3">
        <code className="block break-all font-mono text-13 text-fg">{token.plaintext}</code>
      </div>
      <div className="flex gap-3">
        <Button variant="primary" icon="check" onClick={copyPlaintext} className="min-h-11">
          Copy to clipboard
        </Button>
        <Button variant="secondary" onClick={onDone} className="min-h-11">
          Done
        </Button>
      </div>
    </div>
  );
}
