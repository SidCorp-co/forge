"use client";

import type { ReactNode } from "react";
import { Tooltip as TooltipRoot, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/cn";

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
  multiline?: boolean;
}

export function Tooltip({ label, children, side = "top", multiline = false }: TooltipProps) {
  return (
    <TooltipRoot>
      <TooltipTrigger
        render={<span className="relative inline-flex" />}
        tabIndex={-1}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={cn(
          "w-max rounded-md bg-[var(--ink-900)] px-2 py-1 font-mono text-11 text-on-accent shadow-md",
          multiline ? "max-w-[240px] whitespace-normal text-left" : "max-w-[calc(100vw-16px)] whitespace-normal",
        )}
      >
        {label}
      </TooltipContent>
    </TooltipRoot>
  );
}
