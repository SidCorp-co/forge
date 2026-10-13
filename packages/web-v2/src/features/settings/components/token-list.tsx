"use client";

// Settings → API Tokens → the list. It answers one question first — what can still reach this
// account — so the tokens that can are the table, with their count said in words above it. What
// cannot any more waits behind one line carrying its number, and the credentials the assistant makes
// for single chat turns are a line of their own: a person did not name them and cannot audit them
// one at a time.
import { useMemo, useState } from "react";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  Icon,
  RowActions,
  SectionTitle,
  Truncated,
  useNow,
} from "@/design";
import {
  chatTurnLine,
  endOf,
  endedLine,
  groupTokens,
  ORIGIN_WORDS,
  originOf,
  reachStatement,
} from "../token-view";
import type { PatScope, PatToken } from "../types";

// A token that expires while the screen is open leaves the live table within this long.
const EXPIRY_CHECK_MS = 15_000;

const THIS_YEAR = new Date().getFullYear();

/** "17 Sep", with the year when it is not this one; "—" when there is no date. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === THIS_YEAR ? {} : { year: "numeric" }),
  });
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : null);

function GrantBadge({ token }: { token: PatToken }) {
  if (token.grant === "full") return <Badge tone="red">Full access</Badge>;
  if (token.grant === "legacy") return <Badge tone="amber">Legacy — full access, never stated</Badge>;
  const names = token.permissions ?? [];
  if (names.length === 0) return <Badge tone="neutral">No permission named</Badge>;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Badge key={name} tone="neutral">
          {name}
        </Badge>
      ))}
    </div>
  );
}

function ScopeBadges({ scopes }: { scopes: PatScope[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} tone={s === "admin" ? "red" : s === "write" ? "amber" : "neutral"}>
          {s}
        </Badge>
      ))}
    </div>
  );
}

const NAME_COLUMN: DataTableColumn<PatToken> = {
  id: "name",
  header: "Name",
  sticky: true,
  sortValue: (t) => t.name,
  cell: (t) => (
    <>
      <Truncated text={t.name} className="font-medium text-fg" />
      <span className="fg-caption block">made by {ORIGIN_WORDS[originOf(t)]}</span>
      <Truncated text={`${t.prefix}…`} className="fg-caption font-mono" />
    </>
  ),
};

/** What a token reaches and when it was made and last used: shared by a live and an ended token. */
function describing(level: (token: PatToken) => string): DataTableColumn<PatToken>[] {
  return [
    {
      id: "level",
      header: "Level",
      cell: (t) => <Badge tone={t.boundProjectId ? "cobalt" : "neutral"}>{level(t)}</Badge>,
    },
    { id: "scopes", header: "Scopes", cell: (t) => <ScopeBadges scopes={t.scopes} /> },
    { id: "grant", header: "Grant", cell: (t) => <GrantBadge token={t} /> },
    {
      id: "created",
      header: "Created",
      firstSort: "desc",
      cellClassName: "font-mono text-muted",
      sortValue: (t) => time(t.createdAt),
      cell: (t) => fmtDate(t.createdAt),
    },
    {
      id: "lastUsed",
      header: "Last used",
      firstSort: "desc",
      cellClassName: "font-mono text-muted",
      sortValue: (t) => time(t.lastUsedAt),
      cell: (t) => fmtDate(t.lastUsedAt),
    },
  ];
}

export interface TokenListProps {
  tokens: readonly PatToken[];
  /** "User-level", or the project a token is bound to. */
  level: (token: PatToken) => string;
  onRevoke: (token: PatToken) => void;
  revoking: boolean;
}

export function TokenList({ tokens, level, onRevoke, revoking }: TokenListProps) {
  const [endedOpen, setEndedOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PatToken | null>(null);
  const now = useNow(EXPIRY_CHECK_MS);
  const groups = useMemo(() => groupTokens(tokens, now), [tokens, now]);
  const chatLine = chatTurnLine(groups.chatTurn);

  const liveColumns = useMemo<DataTableColumn<PatToken>[]>(() => {
    return [
      NAME_COLUMN,
      ...describing(level),
      {
        id: "expires",
        header: "Expires",
        cellClassName: "font-mono text-muted",
        sortValue: (t) => time(t.expiresAt),
        cell: (t) => (t.expiresAt ? fmtDate(t.expiresAt) : "never"),
      },
      {
        id: "actions",
        header: null,
        headerLabel: "Actions",
        align: "end",
        cell: (t) => (
          <RowActions
            subject={t.name}
            busy={revoking}
            actions={[{ id: "revoke", label: "Revoke", variant: "danger", onClick: () => setRevokeTarget(t) }]}
          />
        ),
      },
    ];
  }, [level, revoking]);

  const endedColumns = useMemo<DataTableColumn<PatToken>[]>(
    () => [
      NAME_COLUMN,
      ...describing(level),
      {
        id: "ended",
        header: "Ended",
        cellClassName: "font-mono text-muted",
        sortValue: (t) => time(endOf(t, now)?.at ?? null),
        cell: (t) => {
          const end = endOf(t, now);
          return end ? `${end.kind} ${fmtDate(end.at)}` : "—";
        },
      },
    ],
    [level, now],
  );

  return (
    <section aria-labelledby="your-tokens" className="space-y-3">
      <div>
        <SectionTitle id="your-tokens" className="fg-h3">
          Your tokens
        </SectionTitle>
        <p className="fg-body-sm mt-1" role="status">
          {reachStatement(groups.reaching)}
        </p>
      </div>

      {groups.live.length > 0 && (
        <DataTable
          aria-label="Tokens that can reach your account"
          rows={groups.live}
          columns={liveColumns}
          getRowId={(t) => t.id}
          defaultSort={{ id: "created", desc: true }}
        />
      )}

      {chatLine && <p className="fg-body-sm text-muted">{chatLine}</p>}

      {groups.ended.length > 0 && (
        <div className="border-t border-line-subtle pt-3">
          <button
            type="button"
            aria-expanded={endedOpen}
            onClick={() => setEndedOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-sm text-left fg-body-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name={endedOpen ? "chevronDown" : "chevronRight"} size={14} className="flex-none" />
            {endedLine(groups.ended.length)}
          </button>
          {endedOpen && (
            <div className="mt-3">
              <DataTable
                aria-label="Tokens that no longer reach your account"
                rows={groups.ended}
                columns={endedColumns}
                getRowId={(t) => t.id}
                defaultSort={{ id: "ended", desc: true }}
              />
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={revokeTarget !== null}
        title={`Revoke "${revokeTarget?.name ?? ""}"?`}
        message={`Anything using this token loses access to your account at once, and a revoked token cannot be restored.`}
        confirmLabel="Revoke token"
        tone="danger"
        loading={revoking}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) onRevoke(revokeTarget);
          setRevokeTarget(null);
        }}
      />
    </section>
  );
}
