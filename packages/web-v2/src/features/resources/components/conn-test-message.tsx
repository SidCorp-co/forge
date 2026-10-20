/** Forge's sentences, then the git host's own words (`diagnostics.hostSaid`) on a line of their own. */
export function ConnTestMessage({ message, hostSaid }: { message: string; hostSaid?: string }) {
	return (
		<>
			<span className="block">{message}</span>
			{hostSaid ? <span className="block">{`The git host said: ${hostSaid}`}</span> : null}
		</>
	);
}
