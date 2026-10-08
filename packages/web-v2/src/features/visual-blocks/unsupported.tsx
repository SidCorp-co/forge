"use client";

/** A block this screen cannot draw, named. It is never left out: a vanished block reads as an answer that was never given. */
export function UnsupportedBlock({ kind, reason }: { kind: string; reason?: string }) {
  return (
    <p className="text-[12.5px] text-muted" data-testid="visual-block-unsupported" data-kind={kind}>
      This answer has a {kind} block this screen cannot show{reason === undefined ? "." : `: ${reason}.`}
    </p>
  );
}
