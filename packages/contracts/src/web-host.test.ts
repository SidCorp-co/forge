import { describe, expect, it } from "vitest";
import { matchesRoute, readWebHostManifest } from "./web-host.js";

describe("a route the web declares", () => {
	it("matches its own path, a trailing slash either side", () => {
		expect(matchesRoute("/", "/")).toBe(true);
		expect(matchesRoute("/login/", "/login")).toBe(true);
		expect(matchesRoute("/login", "/login/")).toBe(true);
	});

	it("takes one segment for a param, and no more or fewer", () => {
		expect(matchesRoute("/projects/$slug/", "/projects/hop")).toBe(true);
		expect(matchesRoute("/projects/$slug/", "/projects")).toBe(false);
		expect(matchesRoute("/projects/$slug/", "/projects/hop/issues")).toBe(
			false,
		);
		expect(
			matchesRoute("/projects/$slug/issues/$id/", "/projects/hop/issues/ISS-7"),
		).toBe(true);
	});

	it("takes the rest for a lone $, at least one segment of it", () => {
		expect(matchesRoute("/docs/$", "/docs/a/b/c")).toBe(true);
		expect(matchesRoute("/docs/$", "/docs")).toBe(false);
	});

	it("never matches a path that differs in a fixed segment", () => {
		expect(
			matchesRoute("/projects/$slug/issues/", "/projects/hop/requirements"),
		).toBe(false);
	});
});

describe("the manifest a web build writes", () => {
	const valid = { basePath: "", routes: ["/"], helpSlugs: ["getting-started"] };

	it("is read when every field holds its shape", () => {
		expect(readWebHostManifest(valid)).toEqual(valid);
	});

	it("is refused naming the field that is wrong", () => {
		expect(readWebHostManifest(null)).toEqual({
			refused: "it is not a JSON object",
		});
		expect(readWebHostManifest({ ...valid, basePath: 1 })).toEqual({
			refused: "`basePath` is not a path",
		});
		expect(readWebHostManifest({ ...valid, routes: [] })).toEqual({
			refused: "`routes` is not a non-empty list of paths",
		});
		expect(readWebHostManifest({ ...valid, helpSlugs: [1] })).toEqual({
			refused: "`helpSlugs` is not a list of slugs",
		});
	});
});
