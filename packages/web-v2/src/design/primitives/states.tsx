"use client";

// The three states a page section can be in besides its content: nothing there yet, still reading,
// and could not read. One layout for all three, so a screen never invents its own.

import type { ReactNode } from "react";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { ForgeMascot } from "@/design/patterns/forge-mascot";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";

function StateFrame({ figure, title, titleId, message, action }: { figure?: ReactNode; title?: ReactNode; titleId?: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {figure}
      {title || message ? (
        <div>
          {title ? (
            <p id={titleId} tabIndex={titleId ? -1 : undefined} className="fg-h3 rounded-xs focus-visible:outline-none focus-visible:shadow-focus">
              {title}
            </p>
          ) : null}
          {message ? <p className="fg-body-sm mx-auto mt-1 max-w-xs">{message}</p> : null}
        </div>
      ) : null}
      {action}
    </div>
  );
}

export interface EmptyStateProps {
  title?: string;
  /** One calm line: never cute, never apologetic. */
  message: string;
  action?: { label: string; onClick?: () => void };
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
  /** Id for the headline, which also makes it programmatically focusable. */
  titleId?: string;
}

/** Nothing here yet: the mascot, one calm line, one way forward. */
export function EmptyState({ title, message, action, mascot = true, titleId }: EmptyStateProps) {
  return (
    <StateFrame
      figure={mascot ? <ForgeMascot size={88} mode="blink" ring={false} progress={0.4} /> : undefined}
      title={title}
      titleId={titleId}
      message={message}
      action={
        action ? (
          <Button variant="primary" size="sm" icon="plus" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : undefined
      }
    />
  );
}

export interface LoadingStateProps {
  /** What is being read, when it is worth saying. */
  label?: string;
  /** Mirror a list: this many row-high placeholders in place of the spinner. */
  rows?: number;
}

/** Still reading: row placeholders for a list, else a spinner and its label. */
export function LoadingState({ label, rows }: LoadingStateProps) {
  if (rows) {
    return (
      <div aria-busy="true" aria-label={label} className="divide-y divide-line-subtle">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <div key={i} className="flex h-row items-center gap-3 px-1">
            <Skeleton variant="text" className="w-16" />
            <Skeleton variant="text" className="flex-1" />
          </div>
        ))}
      </div>
    );
  }
  return <StateFrame figure={<Spinner size={20} />} message={label} />;
}

export interface ErrorStateProps {
  title?: string;
  /** Plain cause and remedy, never apologetic. */
  message: string;
  onRetry?: () => void;
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
}

/** Could not read: the mascot stilled, one line, a retry. Never a dead end. */
export function ErrorState({ title, message, onRetry, mascot = true }: ErrorStateProps) {
  const t = useCopy();
  return (
    <StateFrame
      figure={mascot ? <ForgeMascot size={88} mode="blink" ring={false} flicker={false} progress={0.4} /> : undefined}
      title={title ?? t("common.couldNotLoad")}
      message={message}
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" icon="rerun" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        ) : undefined
      }
    />
  );
}

/** A write or read refused inline, where it happened: the act's name, then core's words for why. Nothing when there is no error. */
export function RefusedLine({ label, error, className }: { label?: string; error: unknown; className?: string }) {
  if (!error) return null;
  const why = formatApiError(error);
  return (
    <p role="alert" className={className ?? "fg-caption text-danger-11"}>
      {label ? `${label}: ${why}` : why}
    </p>
  );
}
