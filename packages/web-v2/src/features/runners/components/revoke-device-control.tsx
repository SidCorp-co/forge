"use client";


import { type ChangeEvent, type KeyboardEvent, useState } from "react";
import { Button, Input } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRevokeDevice } from "../hooks";

function matches(typed: string, deviceName: string): boolean {
	return typed.trim() === deviceName.trim();
}

export function RevokeDeviceControl({
	deviceId,
	deviceName,
	onDone,
}: {
	deviceId: string;
	deviceName: string;
	onDone: () => void;
}) {
	const revoke = useRevokeDevice();
	const t = useCopy();
	const [typed, setTyped] = useState("");
	const ok = matches(typed, deviceName);

	const run = () => {
		if (!ok) return;
		revoke.mutate(deviceId, { onSettled: () => onDone() });
	};

	return (
		<span className="inline-flex items-center gap-2">
			<Input
				value={typed}
				placeholder={deviceName}
				aria-label={t("runners.revoke.aria", { name: deviceName })}
				className="h-8 w-56"
				onChange={(e: ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
				onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
					if (e.key === "Enter") run();
				}}
			/>
			<Button
				variant="danger"
				size="sm"
				icon="trash"
				loading={revoke.isPending}
				disabled={!ok}
				onClick={run}
			>
				{t("runners.device.revoke")}
			</Button>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => {
					setTyped("");
					onDone();
				}}
			>
				{t("common.cancel")}
			</Button>
		</span>
	);
}
