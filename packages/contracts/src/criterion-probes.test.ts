/**
 * Which origin answers a kept request probe's path (ISS-470): the production environment's `url`
 * answers every path no service routes, a service only the prefixes its `routes` name, and which
 * origin answers a path is never guessed from the path where an environment with services declares
 * no routes.
 *
 * @direct-test-of packages/contracts/src/criterion-probes.ts
 */

import { describe, expect, it } from "vitest";
import { type ProbeRouting, probeRouteFault, serviceRouting } from "./criterion-probes.js";

/** A forge-shaped production: the web on its `url`, the API as service `api`. */
const FORGE: ProbeRouting = {
	environment: "dev",
	url: "https://forge-dev.example.test",
	services: { api: "https://forge-dev-api.example.test" },
	routes: { api: ["/api", "/version"] },
};

describe("a request is held to the origin that answers its path", () => {
	it("an API path with no service is refused, naming the service that answers it", () => {
		expect(probeRouteFault({ path: "/api/issues/1" }, FORGE)).toBe(
			"`/api/issues/1` is answered by service `api` (it routes `/api`), not by production environment `dev`'s `url`; send `service: \"api\"`",
		);
	});

	it("the same path naming the service is accepted, and so is a web path on the url", () => {
		expect(probeRouteFault({ path: "/api/issues/1", service: "api" }, FORGE)).toBeNull();
		expect(probeRouteFault({ path: "/version?x=1", service: "api" }, FORGE)).toBeNull();
		expect(probeRouteFault({ path: "/projects/forge" }, FORGE)).toBeNull();
	});

	it("a web path sent to a service is refused, naming the url", () => {
		expect(probeRouteFault({ path: "/projects/forge", service: "api" }, FORGE)).toBe(
			"service `api` does not route `/projects/forge`: it is answered by production environment `dev`'s `url`, which answers every path no service routes; leave `service` out",
		);
	});

	it("a prefix claims whole segments only: /apiary is not /api", () => {
		expect(serviceRouting("/apiary", FORGE.routes ?? {})).toBeNull();
		expect(serviceRouting("/api", FORGE.routes ?? {})).toEqual({ service: "api", prefix: "/api" });
	});

	it("the longest prefix wins between services", () => {
		const routes = { api: ["/api"], admin: ["/api/admin"] };
		expect(serviceRouting("/api/admin/users", routes)?.service).toBe("admin");
		expect(serviceRouting("/api/issues", routes)?.service).toBe("api");
	});
});

describe("where the routing cannot be known", () => {
	it("an environment with services and no routes refuses every request, naming the field", () => {
		const fault = probeRouteFault({ path: "/api/issues/1" }, { ...FORGE, routes: null });
		expect(fault).toContain("declares services (api) and no `routes`");
		expect(fault).toContain("environments.dev.routes");
		expect(probeRouteFault({ path: "/", service: "api" }, { ...FORGE, routes: null })).toContain(
			"no `routes`",
		);
	});

	it("an environment with one origin needs no routes", () => {
		const single = { environment: "live", url: "https://app.example.test", services: {}, routes: null };
		expect(probeRouteFault({ path: "/api/anything" }, single)).toBeNull();
	});

	it("an undeclared service, or no url for a path no service routes, is refused", () => {
		expect(probeRouteFault({ path: "/api/x", service: "admin" }, FORGE)).toContain(
			"declares no service `admin` (it declares api)",
		);
		expect(probeRouteFault({ path: "/projects" }, { ...FORGE, url: null })).toContain(
			"declares no `url`",
		);
	});
});
