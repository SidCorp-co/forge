
// The self an org admin writes for one agent: who it is (soul, greeting,
// glyph), what it always does (standing instructions), and when it speaks
// (presence). Stored in the database, rendered into every turn the agent takes.
import { useState } from "react";
import type { AgentSelf, AgentSelfPatch, AnswerInGroupMode } from "@forge/contracts/assistant-self";
import {
  Button,
  PageSectionTitle,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import { useAgentSelf, useUpdateAgentSelf } from "../hooks";

const answerInGroup = (t: Copy): SelectOption[] => [
  { value: "window", label: t("settings.agents.self.window") },
  { value: "mention", label: t("settings.agents.self.mention") },
  { value: "tool", label: t("settings.agents.self.tool") },
];
const onOff = (t: Copy): SelectOption[] => [
  { value: "off", label: t("settings.agents.self.off") },
  { value: "on", label: t("settings.agents.self.on") },
];
const MINUTE = 60_000;

interface Draft {
  soul: string;
  instructions: string;
  greeting: string;
  emoji: string;
  answerInGroup: AnswerInGroupMode;
  heartbeat: boolean;
  heartbeatMinutes: string;
  backoffAfter: string;
  dormantHours: string;
}

function draftOf(self: AgentSelf): Draft {
  const p = self.presence;
  return {
    soul: self.soul ?? "",
    instructions: self.instructions ?? "",
    greeting: self.greeting ?? "",
    emoji: self.emoji ?? "",
    answerInGroup: p.answerInGroup ?? "window",
    heartbeat: p.heartbeat?.enabled ?? false,
    heartbeatMinutes: p.heartbeat?.intervalMs ? String(p.heartbeat.intervalMs / MINUTE) : "",
    backoffAfter: p.backoffAfter !== undefined ? String(p.backoffAfter) : "",
    dormantHours: p.dormantMs !== undefined ? String(p.dormantMs / (60 * MINUTE)) : "",
  };
}

const text = (v: string): string | null => (v.trim() === "" ? null : v);
const num = (v: string, scale = 1): number | null =>
  v.trim() === "" ? null : Number(v) * scale;

/**
 * The patch a draft sends: text fields whole, presence keys one by one — an
 * emptied number is sent as `null`, which UNSETS the key so the default folds back.
 */
function patchOf(draft: Draft): AgentSelfPatch {
  return {
    soul: text(draft.soul),
    instructions: text(draft.instructions),
    greeting: text(draft.greeting),
    emoji: text(draft.emoji),
    presence: {
      answerInGroup: draft.answerInGroup,
      heartbeat: {
        enabled: draft.heartbeat,
        intervalMs: num(draft.heartbeatMinutes, MINUTE),
      },
      backoffAfter: num(draft.backoffAfter),
      dormantMs: num(draft.dormantHours, 60 * MINUTE),
    },
  };
}

export function AgentSelfEditor({
  orgId,
  agentUserId,
  handle,
}: {
  orgId: string | null;
  agentUserId: string;
  handle: string;
}) {
  const selfQ = useAgentSelf(orgId, agentUserId);
  const save = useUpdateAgentSelf(orgId);
  const { toast } = useToast();
  // only the edit is local: until one is made, the draft is what core holds
  const [edit, setEdit] = useState<Draft | null>(null);
  const draft = edit ?? (selfQ.data ? draftOf(selfQ.data) : null);
  const t = useCopy();

  if (selfQ.isError) {
    return (
      <div className="flex items-center gap-3" data-testid={`agent-self-error-${agentUserId}`}>
        <p className="fg-body-sm text-danger">{formatApiError(selfQ.error)}</p>
        <Button variant="secondary" onClick={() => void selfQ.refetch()}>
          {t("settings.agents.self.tryAgain")}
        </Button>
      </div>
    );
  }
  if (selfQ.isLoading || !draft) return <Skeleton className="h-40 w-full rounded-md" />;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setEdit({ ...draft, [key]: value });

  async function onSave() {
    if (!draft) return;
    try {
      await save.mutateAsync({ agentUserId, patch: patchOf(draft) });
      toast({ title: t("settings.agents.self.saved", { handle }), tone: "success" });
    } catch (err) {
      toast({ title: t("settings.agents.self.saveFailed"), description: formatApiError(err), tone: "error" });
    }
  }

  return (
    <div className="space-y-4" data-testid={`agent-self-${agentUserId}`}>
      <Field label={t("settings.agents.self.soul")}>
        <Textarea value={draft.soul} rows={5} maxLength={8000} onChange={(e) => set("soul", e.target.value)} />
      </Field>
      <Field label={t("settings.agents.self.instructions")}>
        <Textarea
          value={draft.instructions}
          rows={4}
          maxLength={8000}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.agents.self.greeting")}>
          <Input value={draft.greeting} maxLength={500} onChange={(e) => set("greeting", e.target.value)} />
        </Field>
        <Field label={t("settings.agents.self.glyph")}>
          <Input value={draft.emoji} maxLength={16} onChange={(e) => set("emoji", e.target.value)} />
        </Field>
      </div>
      <PageSectionTitle className="fg-label mt-2">{t("settings.agents.self.whenSpeaks")}</PageSectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.agents.self.group")}>
          <Select
            options={answerInGroup(t)}
            value={draft.answerInGroup}
            onChange={(v) => set("answerInGroup", v as AnswerInGroupMode)}
          />
        </Field>
        <Field label={t("settings.agents.self.backoff")}>
          <Input
            inputMode="numeric"
            value={draft.backoffAfter}
            onChange={(e) => set("backoffAfter", e.target.value)}
          />
        </Field>
        <Field label={t("settings.agents.self.heartbeat")}>
          <Select
            options={onOff(t)}
            value={draft.heartbeat ? "on" : "off"}
            onChange={(v) => set("heartbeat", v === "on")}
          />
        </Field>
        <Field label={t("settings.agents.self.interval")}>
          <Input
            inputMode="numeric"
            value={draft.heartbeatMinutes}
            onChange={(e) => set("heartbeatMinutes", e.target.value)}
          />
        </Field>
        <Field label={t("settings.agents.self.dormant")}>
          <Input
            inputMode="numeric"
            value={draft.dormantHours}
            onChange={(e) => set("dormantHours", e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button variant="primary" loading={save.isPending} onClick={() => void onSave()} className="min-h-11">
          {t("settings.agents.self.save")}
        </Button>
      </div>
    </div>
  );
}
