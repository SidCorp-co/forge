"use client";

// cm:edge protocol -> packages/core/src/devices/routes.ts — `DELETE /api/devices/:id` sits behind `requireFreshAuth(5)`, so revoking is TWO steps whenever the user's last sign-in is older than five minutes: the 403 is the normal path, not an error to report. A caller that treats it as a failure leaves the operator with a message naming a state they have no control to leave.

import { type ChangeEvent, type KeyboardEvent, useState } from "react";
import { isFreshAuthError } from "@/features/auth/fresh-auth";
import { useReauth } from "@/features/settings/hooks";
import { Button, Input } from "@/design";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { useRevokeDevice } from "../hooks";

// cm:guard the retry MUST reuse this same control's mutation rather than asking the caller to fire again — the fresh-auth stamp lives on the users row and expires in five minutes, so a design that hands the user back to another screen to re-authenticate is what the banner here used to say and it pointed at a Settings tab with no standalone reauth action. The password step and the retry belong in one place or the loop never closes.
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
	const reauth = useReauth();
	const { toast } = useToast();
	const [needsPassword, setNeedsPassword] = useState(false);
	const [password, setPassword] = useState("");

	const runRevoke = () =>
		revoke.mutate(deviceId, {
			onSuccess: () => onDone(),
			onError: (err) => {
				if (isFreshAuthError(err)) {
					setNeedsPassword(true);
					return;
				}
				onDone();
			},
		});

	const confirmWithPassword = () =>
		reauth.mutate(password, {
			onSuccess: () => {
				setPassword("");
				runRevoke();
			},
			onError: (err) =>
				toast({
					title: "Re-authentication failed",
					description: formatApiError(err),
					tone: "error",
				}),
		});

	if (needsPassword) {
		return (
			<span className="inline-flex items-center gap-2">
				<Input
					type="password"
					value={password}
					autoComplete="current-password"
					placeholder="Your account password"
					aria-label={`Confirm password to revoke ${deviceName}`}
					className="h-8 w-52"
					onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
					onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
						if (e.key === "Enter" && password) confirmWithPassword();
					}}
				/>
				<Button
					variant="danger"
					size="sm"
					loading={reauth.isPending || revoke.isPending}
					disabled={!password}
					onClick={confirmWithPassword}
				>
					Confirm &amp; revoke
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						setNeedsPassword(false);
						setPassword("");
						onDone();
					}}
				>
					Cancel
				</Button>
			</span>
		);
	}

	return (
		<span className="inline-flex items-center gap-2">
			<Button
				variant="danger"
				size="sm"
				icon="trash"
				loading={revoke.isPending}
				onClick={runRevoke}
			>
				Confirm
			</Button>
			<Button variant="ghost" size="sm" onClick={onDone}>
				Cancel
			</Button>
		</span>
	);
}
