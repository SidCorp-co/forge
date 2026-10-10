"use client";

// A POC room (REQ-44): the chat on one side and the live preview on the other. Every member reads the
// same record on a short clock (BC-5), each ask says when the preview showed it and the commit that
// did (BC-4, BC-6), a shown turn is settled from its row, and Settle sends the page the person sees
// as the requirement's picture (BC-7) and merges the branch into dev (BC-8). Core decides every move;
// this draws the record and says by name what core refused. Flat: hairlines and type, no cards.

import type { Room, RoomTurn } from "@forge/contracts/poc-room";
import { ROOM_LIMITS } from "@forge/contracts/poc-room";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { askPageSnapshot, SnapshotUnavailable } from "../idea-snapshot";
import { PreviewFrame } from "./preview-frame";
import { roomApi } from "../room-api";

/** Members read the room again on this clock: what one asks, the other sees within it. */
const ROOM_POLL_MS = 1500;

const roomKey = (id: string) => ["poc-room", id] as const;

export function useRoom(id: string) {
  return useQuery({ queryKey: roomKey(id), queryFn: () => roomApi.get(id), refetchInterval: ROOM_POLL_MS });
}

function useRoomAct<A>(id: string, act: (a: A) => Promise<Room>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: act, onSuccess: (room) => qc.setQueryData(roomKey(id), room) });
}

const short = (sha: string) => sha.slice(0, 7);

function TurnEntry({ room, turn, settled, onSettle, settling }: { room: Room; turn: RoomTurn; settled: boolean; onSettle: () => void; settling: boolean }) {
  const t = useCopy();
  const who = turn.kind === "trim" ? t("previews.room.turn.agent") : (turn.by?.name ?? t("previews.room.turn.agent"));
  return (
    <li data-testid="room-turn" data-seq={turn.seq} data-shown={turn.shownAt ? "yes" : "no"} className="grid gap-1 border-b border-line py-3">
      <p className="fg-caption text-muted">{who}</p>
      <p className="fg-body-sm whitespace-pre-wrap text-fg">{turn.kind === "trim" ? t("previews.room.turn.trim") : turn.ask}</p>
      {turn.shownAt === null ? (
        <p role="status" className="fg-caption text-subtle">
          {t("previews.room.turn.building")}
        </p>
      ) : (
        <p className="fg-caption text-subtle" data-testid="room-turn-shown">
          {t("previews.room.turn.shown", { seconds: ((turn.shownAfterMs ?? 0) / 1000).toFixed(1) })}
          {turn.commit ? ` · ${t("previews.room.turn.commit", { sha: short(turn.commit) })}` : ""}
        </p>
      )}
      {turn.reply ? <p className="fg-body-sm whitespace-pre-wrap text-muted">{turn.reply}</p> : null}
      {turn.kind === "ask" && turn.commit && room.state === "open" && room.canWrite ? (
        settled ? (
          <p className="fg-caption text-fg">{t("previews.room.turn.settled")}</p>
        ) : (
          <div>
            <Button size="sm" variant="secondary" loading={settling} onClick={onSettle}>
              {t("previews.room.turn.settle")}
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}

function AskBox({ room }: { room: Room }) {
  const t = useCopy();
  const [text, setText] = useState("");
  const ask = useRoomAct(room.id, (body: string) => roomApi.ask(room.id, body));
  if (!room.canWrite) return <p className="fg-caption text-muted">{t("previews.room.ask.readOnly")}</p>;
  const submit = () => {
    const body = text.trim();
    if (body) ask.mutate(body, { onSuccess: () => setText("") });
  };
  return (
    <form
      className="grid gap-2"
      aria-label={t("previews.room.ask.label")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={t("previews.room.ask.label")}
        value={text}
        rows={2}
        maxLength={ROOM_LIMITS.ask}
        placeholder={t("previews.room.ask.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div>
        <Button type="submit" size="sm" disabled={text.trim() === ""} loading={ask.isPending}>
          {t("previews.room.ask.send")}
        </Button>
      </div>
      <RefusedLine label={t("previews.room.ask.failed")} error={ask.error} />
    </form>
  );
}

function SettledList({ room, frame }: { room: Room; frame: React.RefObject<HTMLIFrameElement | null> }) {
  const t = useCopy();
  const [alt, setAlt] = useState("");
  const unsettle = useRoomAct(room.id, (itemId: string) => roomApi.unsettleItem(room.id, itemId));
  const settle = useRoomAct(room.id, async (text: string) => {
    if (!frame.current) throw new SnapshotUnavailable("silent", "the preview frame is not on the page");
    const snapshot = await askPageSnapshot(frame.current, new URL(room.preview.url).origin);
    return roomApi.settle(room.id, { alt: text, snapshot });
  });
  return (
    <section aria-label={t("previews.room.items.title")} className="grid gap-2 border-t border-line pt-3">
      <h2 className="fg-label text-fg">{t("previews.room.items.title")}</h2>
      {room.items.length === 0 ? <p className="fg-caption text-muted">{t("previews.room.items.none")}</p> : null}
      <ul className="grid">
        {room.items.map((item) => (
          <li key={item.id} data-testid="room-item" className="flex items-baseline gap-3 border-b border-line py-2">
            <span className="fg-body-sm min-w-0 flex-1 text-fg">{item.text}</span>
            <span className="fg-caption font-mono text-subtle">{short(item.commit)}</span>
            {room.state === "open" && room.canWrite ? (
              <Button size="sm" variant="ghost" loading={unsettle.isPending} onClick={() => unsettle.mutate(item.id)}>
                {t("previews.room.items.remove")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {room.state === "open" && room.canWrite && room.items.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t("previews.room.settle.button")}
          onSubmit={(e) => {
            e.preventDefault();
            if (alt.trim()) settle.mutate(alt.trim());
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label={t("previews.room.settle.alt")}>
              <Input value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={alt.trim() === "" || room.preview.state !== "live"} loading={settle.isPending}>
            {t("previews.room.settle.button")}
          </Button>
        </form>
      ) : null}
      <RefusedLine label={t("previews.room.settle.failed")} error={settle.error} />
    </section>
  );
}

function SettleOutcome({ room, slug }: { room: Room; slug: string | undefined }) {
  const t = useCopy();
  const s = room.settle;
  if (room.state === "abandoned") return <p className="fg-body-sm text-muted">{t("previews.room.abandoned")}</p>;
  if (room.state === "open" && room.detail) {
    return (
      <p role="alert" className="fg-caption text-danger" data-testid="room-not-settled">
        {t("previews.room.backToOpen")} {room.detail}
      </p>
    );
  }
  if (!s) return null;
  if (room.state === "settling") return <p role="status" className="fg-body-sm text-muted">{t("previews.room.settling", { into: s.into })}</p>;
  return (
    <div role="status" data-testid="room-settled" className="grid gap-1">
      {s.mergeSha ? <p className="fg-body-sm text-fg">{t("previews.room.settled", { into: s.into, sha: short(s.mergeSha) })}</p> : null}
      {s.requirement && s.revision ? (
        <p className="fg-body-sm text-fg">
          {slug ? (
            <Link className="text-link hover:underline" href={requirementHref(slug, s.requirement)}>
              {t("previews.room.settled.requirement", { key: s.requirement, revision: s.revision })}
            </Link>
          ) : (
            t("previews.room.settled.requirement", { key: s.requirement, revision: s.revision })
          )}
        </p>
      ) : null}
      {s.issue ? <p className="fg-body-sm text-fg">{t("previews.room.settled.issue", { issue: s.issue.displayId ?? s.issue.id })}</p> : null}
      {s.refusals.length > 0 ? (
        <p className="fg-caption text-danger">
          {t("previews.room.settled.refused")} {s.refusals.map((r) => `${r.code}: ${r.detail}`).join("; ")}
        </p>
      ) : null}
    </div>
  );
}

/** `slug` comes from the page that mounts the screen, which reads the project. */
export function RoomScreen({ roomId, slug }: { roomId: string; slug: string | undefined }) {
  const t = useCopy();
  const roomQ = useRoom(roomId);
  const qc = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const joinRoom = useMutation({ mutationFn: () => roomApi.join(roomId), onSuccess: (room) => qc.setQueryData(roomKey(roomId), room) });
  const { mutate: join } = joinRoom;
  const settleItem = useRoomAct(roomId, (turnId: string) => roomApi.settleItem(roomId, turnId));
  const abandon = useRoomAct(roomId, () => roomApi.abandon(roomId));
  const joinedRef = useRef(false);
  // opening the room's link is joining it: the member is listed, and a sleeping preview wakes
  useEffect(() => {
    if (joinedRef.current) return;
    joinedRef.current = true;
    join();
  }, [join]);

  const room = roomQ.data;
  if (roomQ.isError && !room) {
    return (
      <p role="alert" className="fg-body-sm text-danger">
        {t("previews.room.loadFailed")}: {formatApiError(roomQ.error)}
      </p>
    );
  }
  if (!room) return <p className="fg-body-sm text-muted">{t("previews.room.loading")}</p>;
  const settledTurns = new Set(room.items.map((i) => i.turnId));
  const asleep = room.preview.state === "idle_closed";
  return (
    <div data-testid="room" data-state={room.state} className="grid gap-6 lg:grid-cols-5">
      <section aria-label={t("previews.room.title", { key: room.about.key })} className="grid content-start gap-3 lg:col-span-2">
        <header className="grid gap-1 border-b border-line pb-3">
          <h1 className="fg-h3 text-fg">{t("previews.room.title", { key: room.about.key })}</h1>
          <p className="fg-body-sm text-muted">{room.about.title}</p>
          <p className="fg-caption text-subtle" data-testid="room-members">
            {t("previews.room.members", { names: room.members.map((m) => m.name).join(", ") })}
          </p>
          <p className="fg-caption text-subtle">
            <span className="font-mono">{room.branch}</span> · {t(room.data === "demo" ? "previews.room.data.demo" : "previews.room.data.environment")}
          </p>
        </header>
        <ol className="grid">
          {room.turns.map((turn) => (
            <TurnEntry key={turn.id} room={room} turn={turn} settled={settledTurns.has(turn.id)} settling={settleItem.isPending && settleItem.variables === turn.id} onSettle={() => settleItem.mutate(turn.id)} />
          ))}
        </ol>
        <RefusedLine error={settleItem.error} />
        {room.state === "open" ? <AskBox room={room} /> : null}
        <SettledList room={room} frame={frameRef} />
        <SettleOutcome room={room} slug={slug} />
        {room.canWrite && (room.state === "open" || room.state === "settling") ? (
          <div className="border-t border-line pt-3">
            <Button size="sm" variant="ghost" loading={abandon.isPending} onClick={() => abandon.mutate(undefined)}>
              {t("previews.room.abandon")}
            </Button>
            <RefusedLine label={t("previews.room.abandonFailed")} error={abandon.error} />
          </div>
        ) : null}
      </section>
      <section aria-label={t("previews.title")} className="grid content-start gap-2 lg:col-span-3">
        {room.preview.state === "live" ? <PreviewFrame preview={room.preview} issueLabel={room.about.key} height={640} frameRef={frameRef} /> : null}
        {asleep ? (
          <div className="grid gap-2">
            <p className="fg-body-sm text-muted">{t("previews.room.asleep")}</p>
            <div>
              <Button size="sm" loading={joinRoom.isPending} onClick={() => join()}>
                {t("previews.room.join")}
              </Button>
            </div>
          </div>
        ) : null}
        {room.preview.state === "starting" ? <p role="status" className="fg-body-sm text-muted">{t("previews.idea.starting")}</p> : null}
        {room.preview.state === "failed" ? (
          <p role="alert" className="fg-body-sm text-danger" data-testid="room-preview-failed">
            {room.preview.reason} {room.preview.detail}
          </p>
        ) : null}
        <RefusedLine label={t("previews.room.joinFailed")} error={joinRoom.error} />
      </section>
    </div>
  );
}
