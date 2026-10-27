"use client";

import type { ReleaseNotes } from "@forge/contracts";
import { useState } from "react";
import { Button, Field, Markdown, Radio, RadioGroup, Textarea } from "@/design";
import { useSaveReleaseNote } from "../hooks";
import type { IssueDetail, IssueStatus } from "../types";
import { FlatSection } from "./flat-section";

/* status-tuple: differs — the statuses where the work is built and not yet released, which is the
   one reading that lets this section speak of the change in the future tense. It is a heading choice,
   not a lifecycle set, and a status outside it falls to the neutral heading rather than a guess. */
export const BUILT_NOT_RELEASED: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "developed",
  "testing",
  "tested",
  "awaiting_release",
  "releasing",
]);

/** The section's heading by status, which the help quotes (ISS-1421 r40). */
export function releaseNoteHeading(status: IssueStatus): string {
  if (status === "closed") return "What changed";
  if (BUILT_NOT_RELEASED.has(status)) return "What will change once it is released";
  return "Release note";
}

function sentence(status: IssueStatus, userFacing: string, skip: boolean): string {
  if (!skip) return userFacing;
  return status === "closed"
    ? "Nothing you would see changed — this work had no user-facing part."
    : "Nothing you would see changes — this work has no user-facing part.";
}

/* status-tuple: differs — the built statuses before a release claims the issue, where the release
   gate asks for a note; once a release holds it, the note it closes with is the one it carries. */
export const NOTE_WRITTEN_HERE: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "developed",
  "testing",
  "tested",
  "awaiting_release",
]);

/** Each kind of change in a person's words, and the one that says nothing a user sees changed. */
const KINDS: ReadonlyArray<{ value: ReleaseNotes["section"]; label: string }> = [
  { value: "Added", label: "Something new" },
  { value: "Changed", label: "A change to something that was there" },
  { value: "Fixed", label: "A fix" },
  { value: "Removed", label: "Something taken away" },
  { value: "Security", label: "A security fix" },
  { value: "Skip", label: "Nothing a user sees changes" },
];

const NOTE_MAX = 500;

/** What a disabled Save waits for, said beside it: judge-160 typed a note, chose no kind, and met a
 *  dimmed button with no reason (ISS-1421 r39). Null once both are given. */
export function waitingOn(section: ReleaseNotes["section"] | "", said: string): string | null {
  if (section === "") return "Choose what kind of change this is to save the note.";
  if (section !== "Skip" && said === "") return "Write what a user will see to save the note.";
  return null;
}

/** The note the release gate asks for, written where it asks (ISS-1421 r38, judge-155 found no field). */
function ReleaseNoteWriter({ issueId }: { issueId: string }) {
  const save = useSaveReleaseNote(issueId);
  const [section, setSection] = useState<ReleaseNotes["section"] | "">("");
  const [line, setLine] = useState("");
  const skip = section === "Skip";
  const said = line.trim();
  const ready = section !== "" && (skip || said.length > 0);
  const waitsFor = waitingOn(section, said);
  const waitsId = `release-note-waits-${issueId}`;
  return (
    <FlatSection title="Release note">
      <div className="flex flex-col gap-3">
        <p className="fg-body-sm text-muted">
          This issue has no release note, and a release will not close it without one. Write the one line a user
          would read about this change, or say that nothing a user sees changes.
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="fg-label mb-2">What kind of change</legend>
          <RadioGroup name={`release-note-${issueId}`} value={section} onChange={(v) => setSection(v as ReleaseNotes["section"])}>
            {KINDS.map((k) => (
              <Radio key={k.value} value={k.value} label={k.label} />
            ))}
          </RadioGroup>
        </fieldset>
        {!skip && (
          <Field label="What a user will see" required>
            <Textarea rows={2} maxLength={NOTE_MAX} value={line} onChange={(e) => setLine(e.target.value)} />
          </Field>
        )}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {waitsFor ? (
            <p id={waitsId} className="fg-caption text-muted">
              {waitsFor}
            </p>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            disabled={!ready || save.isPending}
            aria-describedby={waitsFor ? waitsId : undefined}
            onClick={() => {
              if (section === "") return;
              save.mutate({ section, userFacing: skip ? "-" : said });
            }}
          >
            Save release note
          </Button>
        </div>
      </div>
    </FlatSection>
  );
}

/**
 * The release note's plain-language line, on the issue page of the person who filed the work,
 * rendered as the markdown it is written in so its markup never shows as characters. The heading
 * says only what the status establishes: a Reopened issue keeps its earlier note under "Release
 * note" instead of calling work that already shipped a change still to come. Where the release
 * gate would ask for a missing one, a reader who may change the issue writes it here.
 */
export function ReleaseNoteSection({
  issue,
  canWrite,
}: {
  issue: Pick<IssueDetail, "id" | "status" | "releaseNotes">;
  /** Whether the reader holds the member role the issue's PATCH takes. */
  canWrite: boolean;
}) {
  const note = issue.releaseNotes;
  if (!note && canWrite && NOTE_WRITTEN_HERE.has(issue.status)) return <ReleaseNoteWriter issueId={issue.id} />;
  if (!note || issue.status === "dropped") return null;
  return (
    <FlatSection title={releaseNoteHeading(issue.status)}>
      <Markdown>{sentence(issue.status, note.userFacing, note.section === "Skip")}</Markdown>
    </FlatSection>
  );
}
