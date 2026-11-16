// How a fresh build reaches dist without dist ever being absent (ISS-1254). The build emits into a
// staging directory of its own inside dist, then moves each file over its old one by rename, which
// replaces it in one step: a process importing @forge/contracts meanwhile reads every module whole,
// the old one or the new one, and never a missing dist or a half-written file. The build this
// replaced removed dist first, and a builder's tests failed mid-import while another builder rebuilt.

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A staging directory's name: `.next-<pid of the build that owns it>-<random>`. */
const STAGING = /^\.next-(\d+)-/;

/** The file paths under `abs`, relative to it, staging directories left out. */
function filesUnder(abs, rel = "") {
	const out = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		if (!rel && STAGING.test(entry.name)) continue;
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory())
			out.push(...filesUnder(join(abs, entry.name), path));
		else out.push(path);
	}
	return out;
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
};

/**
 * A new staging directory inside `dist`, made after removing those whose build is no longer running
 * (a build killed before it published leaves its own behind). Two builds at once each stage apart.
 */
export function stagingDir(dist) {
	mkdirSync(dist, { recursive: true });
	for (const entry of readdirSync(dist)) {
		const owner = STAGING.exec(entry);
		if (owner && !alive(Number(owner[1])))
			rmSync(join(dist, entry), { recursive: true, force: true });
	}
	return mkdtempSync(join(dist, `.next-${process.pid}-`));
}

/**
 * Move every file of `staged` into `dist` by rename, then remove each file of `dist` the new build
 * did not emit (a module whose source was deleted), and the emptied staging directory.
 */
export function publish(staged, dist) {
	const fresh = filesUnder(staged);
	for (const rel of fresh) {
		mkdirSync(dirname(join(dist, rel)), { recursive: true });
		renameSync(join(staged, rel), join(dist, rel));
	}
	const kept = new Set(fresh);
	for (const rel of filesUnder(dist))
		if (!kept.has(rel)) rmSync(join(dist, rel));
	rmSync(staged, { recursive: true, force: true });
}
