// One bound channel's page (REQ-75 r6 BC-30): who answers the room first (ISS-1180), then its record —
// Members, Rules, Common issues and Routes, each a flat table with hairline dividers. A member's roles
// read inferred or confirmed (BC-31..BC-33), and a person corrects them in place, which confirms them.
// An empty table reads "Not recorded yet", never "None": the record holds only what was confirmed, so
// a room with people in it reads empty until someone records them, and the act that fills it stands
// beside it. The page's back control goes to Channels.

import {
  CHANNEL_ROLE_LABEL,
  CHANNEL_ROLES,
  type ChannelMemberView,
  type ChannelRole,
  type ChannelView,
} from "@forge/contracts/support-channel";
import { useState, type ReactNode } from "react";
import { Button, Checkbox, DetailHeader, Input, PageSectionTitle, Table, TBody, TD, TH, THead, TR } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAddRule, useChannel, useConfirmMember } from "../hooks";
import { ChannelAgent } from "./channel-agent";
import { channelsListHref } from "./channels-screen";

type T = ReturnType<typeof useCopy>;

function RecordTable({ title, empty, rows, head, act, children }: { title: string; empty: string; rows: number; head: ReactNode; act?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageSectionTitle>{title}</PageSectionTitle>
        {act}
      </div>
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

/** A member's roles corrected, or, with no member, a new one named: either is written confirmed (BC-33). */
function MemberEdit({ member, onDone, projectId, rid }: { member: ChannelMemberView | null; onDone: () => void; projectId: string; rid: string }) {
  const t = useCopy();
  const [username, setUsername] = useState(member?.username ?? "");
  const [roles, setRoles] = useState<ChannelRole[]>(member?.roles ?? []);
  const [askFor, setAskFor] = useState(member?.askFor ?? "");
  const named = username.trim().replace(/^@/, "");
  const save = useConfirmMember(projectId, rid);
  const toggle = (r: ChannelRole, on: boolean) => setRoles((cur) => (on ? [...cur, r] : cur.filter((x) => x !== r)));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-3">
        {CHANNEL_ROLES.map((r) => (
          <Checkbox key={r} checked={roles.includes(r)} onChange={(on) => toggle(r, on)} label={CHANNEL_ROLE_LABEL[r]} />
        ))}
      </div>
      {member ? null : <Input aria-label={t("channels.username")} placeholder={t("channels.username")} value={username} onChange={(e) => setUsername(e.target.value)} />}
      <Input aria-label={t("channels.col.askFor")} placeholder={t("channels.col.askFor")} value={askFor} onChange={(e) => setAskFor(e.target.value)} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={roles.length === 0 || named === "" || save.isPending}
          onClick={() =>
            save.mutate(
              { username: named, write: { roles: CHANNEL_ROLES.filter((r) => roles.includes(r)), askFor: askFor.trim() || null } },
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

function AddMember({ projectId, rid }: { projectId: string; rid: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="basis-full">
      <MemberEdit member={null} projectId={projectId} rid={rid} onDone={() => setOpen(false)} />
    </div>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
      {t("channels.addMember")}
    </Button>
  );
}

function AddRule({ projectId, rid }: { projectId: string; rid: string }) {
  const t = useCopy();
  const [text, setText] = useState<string | null>(null);
  const add = useAddRule(projectId, rid);
  if (text === null) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setText("")}>
        {t("channels.addRule")}
      </Button>
    );
  }
  return (
    <div className="grid basis-full gap-2">
      <Input aria-label={t("channels.col.rule")} placeholder={t("channels.col.rule")} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" disabled={text.trim() === "" || add.isPending} onClick={() => add.mutate(text.trim(), { onSuccess: () => setText(null) })}>
          {t("channels.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setText(null)}>
          {t("channels.cancel")}
        </Button>
      </div>
      {add.isError && <p className="fg-body-sm text-danger">{t("channels.saveFailed", { reason: add.error.message })}</p>}
    </div>
  );
}

export function ChannelRecord({ channel, projectId, t }: { channel: ChannelView; projectId: string; t: T }) {
  return (
    <div className="grid gap-6">
      <RecordTable
        title={t("channels.members")}
        empty={t("channels.notRecorded")}
        act={<AddMember projectId={projectId} rid={channel.rid} />}
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
        empty={t("channels.notRecorded")}
        act={<AddRule projectId={projectId} rid={channel.rid} />}
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
        empty={t("channels.notRecorded")}
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
        empty={t("channels.notRecorded")}
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
              {r.route === "forge" ? t("channels.forgeMaster") : r.members.length ? r.members.map((u) => `@${u}`).join(", ") : <span className="text-muted">{t("channels.notRecorded")}</span>}
            </TD>
          </TR>
        ))}
      </RecordTable>
    </div>
  );
}

export function ChannelScreen({ projectId, slug, rid }: { projectId: string; slug: string; rid: string }) {
  const t = useCopy();
  const q = useChannel(projectId, rid);
  const name = q.data?.channel.name;
  return (
    <div className="grid gap-4 px-5 py-4 max-md:px-3">
      <DetailHeader back={{ href: channelsListHref(slug), label: t("channels.title") }} title={name ? `#${name}` : t("channels.unnamed")} />
      <QueryBoundary query={q} loadingLabel={t("channels.loading")}>
        {(data) => (
          <>
            <ChannelAgent agent={data.channel.agent} slug={slug} />
            <ChannelRecord channel={data.channel} projectId={projectId} t={t} />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
