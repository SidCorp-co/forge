// The three spellings a project document's `source.git.repository` takes, read one way everywhere.

export type RepositoryRef =
	| { kind: "hosted"; host: string; path: string }
	| { kind: "ssh"; user: string; host: string; path: string }
	| { kind: "local"; path: string };

const SSH = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):(.+?)(?:\.git)?$/;

/** `host.tld/owner/repo`, `user@host.tld:owner/repo[.git]`, or an absolute path, as the schema admitted it. */
export function parseRepository(repository: string): RepositoryRef {
	if (repository.startsWith("/")) return { kind: "local", path: repository };
	const ssh = SSH.exec(repository);
	if (ssh) {
		return {
			kind: "ssh",
			user: ssh[1] as string,
			host: (ssh[2] as string).toLowerCase(),
			path: ssh[3] as string,
		};
	}
	const slash = repository.indexOf("/");
	return {
		kind: "hosted",
		host: repository.slice(0, slash).toLowerCase(),
		path: repository.slice(slash + 1),
	};
}

/** The host a binding must reach to serve the repository; null for a local path, which no host serves. */
export function hostOf(repository: string): string | null {
	const ref = parseRepository(repository);
	return ref.kind === "local" ? null : ref.host;
}

/** `host/owner/repo` lowercased, so an SSH remote and a hosted name of one repository compare equal; null for a local path. */
export function repositoryIdentity(repository: string): string | null {
	const ref = parseRepository(repository);
	return ref.kind === "local" ? null : `${ref.host}/${ref.path}`.toLowerCase();
}
