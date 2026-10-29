// One bound channel's record (REQ-75 r6 BC-30): Members, Rules, Common issues and Routes, each a
// flat table with hairline dividers. A member's roles read inferred or confirmed (BC-31..BC-33), and
// a person corrects them in place, which confirms them.

import {
  CHANNEL_ROLE_LABEL,
  CHANNEL_ROLES,
  type ChannelMemberView,
  type ChannelRole,
  type ChannelView,
} from "@forge/contracts/support-channel";
import { useState, type ReactNode } from "react";
import { Button, Checkbox, Input, PageSectionTitle, PageTitle, Table, TBody, TD, TH, THead, TR } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useChannel, useConfirmMember } from "../hooks";

type T = ReturnType<typeof useCopy>;

function RecordTable({ title, empty, rows, head, children }: { title: string; empty: string; rows: number; head: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <PageSectionTitle>{title}</PageSectionTitle>
      {rows === 0 ? (
        <p className="fg-body-sm text-muted">{empty}</p>
      ) : (
        <Table aria-label={title}>
          <THead>{head}</THead>
          <TBody>{children}</TBody>
        </Table>
      )}
    </section>
  );
}

const roleWords = (roles: readonly string[]) => roles.map((r) => CHANNEL_ROLE_LABEL[r as ChannelRole]).join(" + ");

function MemberEdit({ member, onDone, projectId, rid }: { member: ChannelMemberView; onDone: () => void; projectId: string; rid: string }) {
  const t = useCopy();
  const [roles, setRoles] = useState<ChannelRole[]>(member.roles);
  const [askFor, setAskFor] = useState(member.askFor ?? "");
  const save = useConfirmMember(projectId, rid);
  const toggle = (r: ChannelRole, on: boolean) => setRoles((cur) => (on ? [...cur, r] : cur.filter((x) => x !== r)));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-3">
        {CHANNEL_ROLES.map((r) => (
          <Checkbox key={r} checked={roles.includes(r)} onChange={(on) => toggle(r, on)} label={CHANNEL_ROLE_LABEL[r]} />
        ))}
      </div>
      <Input aria-label={t("channels.col.askFor")} value={askFor} onChange={(e) => setAskFor(e.target.value)} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={roles.length === 0 || save.isPending}
          onClick={() =>
            save.mutate(
              { username: member.username, write: { roles: CHANNEL_ROLES.filter((r) => roles.includes(r)), askFor: askFor.trim() || null } },
              { onSuccess: onDone },
            )
          }
        >
          {t("channels.confirm")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("channels.cancel")}
        </Button>
      </div>
      {save.isError && <p className="fg-body-sm text-danger">{t("channels.saveFailed", { reason: save.error.message })}</p>}
    </div>
  );
}

function ChannelMember({ member, projectId, rid, t }: { member: ChannelMemberView; projectId: string; rid: string; t: T }) {
  const [editing, setEditing] = useState(false);
  return (
    <TR>
      <TD className="fg-body-sm text-fg">@{member.username}</TD>
      {editing ? (
        <TD colSpan={3}>
          <MemberEdit member={member} projectId={projectId} rid={rid} onDone={() => setEditing(false)} />
        </TD>
      ) : (
        <>
          <TD className="fg-body-sm">{roleWords(member.roles)}</TD>
          <TD className="fg-body-sm">{member.askFor ?? "—"}</TD>
          <TD className={member.state === "confirmed" ? "fg-body-sm text-fg" : "fg-body-sm text-muted"} data-state={member.state}>
            {t(member.state === "confirmed" ? "channels.state.confirmed" : "channels.state.inferred")}
          </TD>
        </>
      )}
      <TD>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {t("channels.edit")}
          </Button>
        )}
      </TD>
    </TR>
  );
}

export function ChannelRecord({ channel, projectId, t }: { channel: ChannelView; projectId: string; t: T }) {
  return (
    <div className="grid gap-6">
      <RecordTable
        title={t("channels.members")}
        empty={t("channels.nothing")}
        rows={channel.memberRows.length}
        head={
          <TR>
            <TH>{t("channels.col.member")}</TH>
            <TH>{t("channels.col.roles")}</TH>
            <TH>{t("channels.col.askFor")}</TH>
            <TH>{t("channels.col.state")}</TH>
            <TH />
          </TR>
        }
      >
        {channel.memberRows.map((m) => (
          <ChannelMember key={m.username} member={m} projectId={projectId} rid={channel.rid} t={t} />
        ))}
      </RecordTable>
      <RecordTable
        title={t("channels.rules")}
        empty={t("channels.nothing")}
        rows={channel.ruleRows.length}
        head={
          <TR>
            <TH>{t("channels.col.rule")}</TH>
            <TH>{t("channels.col.by")}</TH>
          </TR>
        }
      >
        {channel.ruleRows.map((r) => (
          <TR key={r.id}>
            <TD className="fg-body-sm text-fg">{r.text}</TD>
            <TD className="fg-body-sm">{r.author ? `@${r.author}` : t("channels.byPerson")}</TD>
          </TR>
        ))}
      </RecordTable>
      <RecordTable
        title={t("channels.commonIssues")}
        empty={t("channels.nothing")}
        rows={channel.commonIssueRows.length}
        head={
          <TR>
            <TH>{t("channels.col.question")}</TH>
            <TH>{t("channels.col.answer")}</TH>
            <TH>{t("channels.col.threads")}</TH>
            <TH>{t("channels.col.feedback")}</TH>
          </TR>
        }
      >
        {channel.commonIssueRows.map((i) => (
          <TR key={i.id}>
            <TD className="fg-body-sm text-fg">{i.question}</TD>
            <TD className="fg-body-sm">{i.answer}</TD>
            <TD className="fg-body-sm">{i.threads}</TD>
            <TD className="fg-body-sm">{i.feedbackKey ?? "—"}</TD>
          </TR>
        ))}
      </RecordTable>
      <RecordTable
        title={t("channels.routes")}
        empty={t("channels.nothing")}
        rows={channel.routes.length}
        head={
          <TR>
            <TH>{t("channels.col.route")}</TH>
            <TH>{t("channels.col.goesTo")}</TH>
          </TR>
        }
      >
        {channel.routes.map((r) => (
          <TR key={r.route}>
            <TD className="fg-body-sm text-fg">{t(`channels.route.${r.route}`)}</TD>
            <TD className="fg-body-sm">
              {r.route === "forge" ? t("channels.forgeMaster") : r.members.length ? r.members.map((u) => `@${u}`).join(", ") : t("channels.nothing")}
            </TD>
          </TR>
        ))}
      </RecordTable>
    </div>
  );
}

export function ChannelScreen({ projectId, rid }: { projectId: string; rid: string }) {
  const t = useCopy();
  const q = useChannel(projectId, rid);
  return (
    <div className="grid gap-4 px-5 py-4 max-md:px-3">
      <QueryBoundary query={q} loadingLabel={t("channels.loading")}>
        {(data) => (
          <>
            <PageTitle>{data.channel.name ? `#${data.channel.name}` : t("channels.title")}</PageTitle>
            <ChannelRecord channel={data.channel} projectId={projectId} t={t} />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
