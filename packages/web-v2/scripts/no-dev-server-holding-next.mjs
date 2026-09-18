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
// The only exit 1 is a live process whose command line says `next dev` and whose cwd resolves inside
// THIS package.

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

/** Every pid whose cwd is inside this package and whose argv invokes `next dev`. */
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
		if (cwd !== PKG && !cwd.startsWith(`${PKG}/`)) continue;
		if (!invokesNextDev(argv)) continue;
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
