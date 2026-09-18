// Refuse `next build` while a `next dev` holds this worktree's `.next`, by name.
//
// Two shapes of the same collision have cost rounds here. `next dev` (Turbopack) writes `.next/dev`
// continuously and `next build` reads and writes `.next` in the same worktree:
//
// 1. 2026-09-16, ISS-1035 — an orphaned dev server from a killed run fed the build a STALE copy of a
//    source file. `tsc` reported four errors at line/column pairs that existed in no version of that
//    file: not the working tree, not HEAD, not any commit on the branch, not `origin/main`. On the
//    same tree `tsc --noEmit -p tsconfig.json` exited 0. That is a WRONG RED in a file you just
//    edited, naming a real rule, with nothing pointing outward — the expensive shape.
// 2. 2026-09-18, ISS-1097 — the run's own walk server, left up while the gate ran, produced
//    `⨯ Another next build process is already running.` Next's own lock caught it, which is the
//    cheap shape, and only because the build happened to reach the lock first.
//
// The second occurrence is what buys a check rather than a firmer sentence. Next's lock does not
// cover case 1: the stale read happens below it, `turbo --force` genuinely re-runs the task, and the
// staleness is inside `.next`.
//
// FAILING OPEN IS DELIBERATE. A guard that cannot tell must not block a build: CI has no `/proc`
// shape to read on some hosts, a container may hide other processes, and a false positive here
// stops everyone from building for a condition that is not there. Every uncertainty below exits 0.
// The only exit 1 is a live process that invokes `next dev` AND whose resolved project directory is
// this package — not merely one whose cwd sits inside it, which is a different claim and was the
// first version's false positive (`next dev /other-worktree/packages/web-v2` launched from here).
//
// There is no unit test beside this file on purpose: `vitest.config` collects `src/**/*.test.{ts,tsx}`
// only, so a test here would never run, which is worse than none. The pure half — `invokesNextDev`
// and `projectDirOf` — was walked over nine cases instead, including both the ones the review named:
// a dev server explicitly serving another worktree resolves to that worktree and is let through, one
// explicitly serving this package resolves here and is caught. The three live states were walked too:
// no server exit 0, a real `next dev -p 3196` in this package exit 1 naming its pid, stopped exit 0.

import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG = realpathSync(resolve(import.meta.dirname, ".."));

/**
 * True only for an argv that INVOKES `next dev`: some element whose basename is `next`, with the
 * very next element being exactly `dev`.
 *
 * The structure is the whole point. Matching the two words anywhere in the command line is what the
 * first version did, and it refused its own first run: the shell that launched this script carried
 * `scripts/no-dev-server-holding-next.mjs` inside a `bash -c` string, so the cmdline held "next" and
 * "dev" and nothing about a server. A wrapper's `-c` payload is ONE argv element, so no wrapper can
 * satisfy the test below — only the process actually running the server, which is the one whose
 * handle on `.next` matters anyway.
 */
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

/**
 * Which project directory a `next dev` argv serves, resolved against that process's cwd — or `null`
 * where it cannot be read confidently, which is a fail-open.
 *
 * The cwd is NOT the project. `next dev [directory]` takes an optional positional, so a developer
 * running `next dev /other-worktree/packages/web-v2` from inside THIS package is serving a different
 * `.next` entirely, and refusing their build here would be the false positive this file's own policy
 * forbids. More than one positional is a shape this does not model: say nothing.
 */
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
		return null; // No procfs to read. Say nothing, build.
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
			continue; // Gone, or not ours to read. Not evidence of anything.
		}
		if (!invokesNextDev(argv)) continue;
		let project = projectDirOf(argv, cwd);
		if (project === null) continue; // Cannot tell which project. Say nothing.
		try {
			project = realpathSync(project);
		} catch {
			continue; // The named directory does not resolve. Not evidence.
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
