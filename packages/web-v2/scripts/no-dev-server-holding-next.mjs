// Refuse `next build` while a `next dev` holds this worktree's `.next`, by name: both read and
// write the same directory, and Next's own lock does not cover the build type-checking a source
// revision the dev server cached. Failing open is deliberate — a guard that cannot tell must not
// block a build, so every uncertainty below exits 0.

import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG = realpathSync(resolve(import.meta.dirname, ".."));

/** True only for an argv that INVOKES `next dev`. A wrapper's `-c` payload is ONE argv element,
 *  so matching the structure rather than the two words anywhere keeps this script's launcher out. */
function invokesNextDev(argv) {
	return argv.some((part, i) => {
		const bin = part.split("/").pop();
		return (bin === "next" || bin === "next.js") && argv[i + 1] === "dev";
	});
}

/** `next dev` options that swallow the token after them, so it is not the project directory. */
const TAKES_A_VALUE = new Set([
	"-p",
	"--port",
	"-H",
	"--hostname",
	"--experimental-https-key",
	"--experimental-https-cert",
	"--experimental-https-ca",
	"--experimental-upload-trace",
]);

/** Which project directory a `next dev` argv serves, resolved against that process's cwd — `null`
 *  where it cannot be read confidently. The cwd is NOT the project: `next dev [directory]` takes
 *  an optional positional, and more than one is a shape this does not model. */
function projectDirOf(argv, cwd) {
	const at = argv.findIndex((part, i) => {
		const bin = part.split("/").pop();
		return (bin === "next" || bin === "next.js") && argv[i + 1] === "dev";
	});
	if (at < 0) return null;
	const rest = argv.slice(at + 2);
	const positionals = [];
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token.startsWith("-")) {
			if (TAKES_A_VALUE.has(token)) i += 1;
			continue;
		}
		positionals.push(token);
	}
	if (positionals.length > 1) return null;
	return positionals.length === 0 ? cwd : resolve(cwd, positionals[0]);
}

/** Every pid whose `next dev` serves THIS package's project directory. */
function devServersHere() {
	let entries;
	try {
		entries = readdirSync("/proc");
	} catch {
		return null;
	}
	const found = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		if (entry === String(process.pid)) continue;
		let cwd;
		let argv;
		try {
			cwd = realpathSync(readlinkSync(join("/proc", entry, "cwd")));
			argv = readFileSync(join("/proc", entry, "cmdline"), "utf8")
				.split("\0")
				.filter(Boolean);
		} catch {
			continue;
		}
		if (!invokesNextDev(argv)) continue;
		let project = projectDirOf(argv, cwd);
		if (project === null) continue;
		try {
			project = realpathSync(project);
		} catch {
			continue;
		}
		if (project !== PKG) continue; // Someone else's `.next`, not ours.
		found.push({ pid: entry, argv: argv.join(" ") });
	}
	return found;
}

const held = devServersHere();
if (held === null || held.length === 0) process.exit(0);

const lines = held.map((p) => `  pid ${p.pid}  ${p.argv}`).join("\n");
process.stderr.write(
	`\nnext build refused: a \`next dev\` is holding ${PKG}/.next\n\n${lines}\n\n` +
		"Both commands read and write the same `.next`, so a build run now either fails on Next's own\n" +
		"lock or — worse — type-checks a revision of a source file the dev server cached earlier and\n" +
		"reports errors at line numbers that exist in no commit. Stop it BY PID (never `pkill -f`,\n" +
		"which takes a sibling worktree's server too), confirm its port is free, then re-run.\n\n" +
		"Running a browser walk against the dev server? Take the walk first and the gate after — the\n" +
		"walk needs the server up and the build needs it gone.\n",
);
process.exit(1);
