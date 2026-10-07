"use client";

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/design/primitives/button";
import { useCopy } from "@/lib/i18n/interface-language";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "default";
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone = "default",
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const t = useCopy();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !loading) onClose();
      }}
    >
      <AlertDialogContent className="gap-4 rounded-xl border border-line bg-surface p-5 text-fg shadow-lg ring-0 data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-[420px]">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="fg-h3">{title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="fg-body-sm text-fg">
            {message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="m-0 flex-row justify-end gap-2.5 border-0 bg-transparent p-0 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
