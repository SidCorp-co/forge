// ePOD x Catalog and Autoflow as the dev instance's bus read them on 2026-10-15 (GET /api/ecosystems/:id/bus),
// with the `declared` uses the D2 change adds, and catalog-api's builder run and two of catalog-fe's link
// guides as read the same day. Data only: the ecosystem page witness mounts over it.

import type { Bus, BuilderRunRecord, LinkRecord } from "@/features/ecosystem/bus";

/** Core's answer as it went over the wire: it carries fields (an impact's consumer and module) the page never reads. */
const wire = <T,>(answer: unknown): T => answer as T;

export const EPOD_CATALOG = wire<Bus>({
 "ecosystem": {
  "id": "58c8e969-38e6-466d-b9a6-256bc68d7c26",
  "slug": "epod-catalog",
  "name": "ePOD x Catalog"
 },
 "projects": [
  {
   "id": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
   "slug": "catalog-api",
   "name": "Catalog API",
   "builder": {
    "id": "6e100b43-3009-481b-bcfa-cc168c236139",
    "trigger": {
     "kind": "joined",
     "sha": "fe1158c15bc5e6dff4660e0ecee90b0fbc2dd2cd",
     "head": {
      "ref": "refs/heads/dev",
      "readAt": "2026-10-06T00:33:47.000Z",
      "via": "runner-checkout"
     }
    },
    "steps": [
     {
      "name": "read-repo",
      "status": "succeeded",
      "detail": "Read refs/heads/dev at fe1158c1 (app/, config/, routes/, docs/architecture/catalog-integrations.json)."
     },
     {
      "name": "find-outbound-calls",
      "status": "succeeded",
      "detail": "10 outbound uses, none to an ecosystem member. No file on any branch calls ePOD (apiKeyContext, assignProductToStores, setProductStoreVisibility and 'epod' grep empty at fe1158c1)."
     },
     {
      "name": "match-contracts",
      "status": "succeeded",
      "detail": "No use matches epod/storefront-graphql 1.0.0, the only contract published in epod-catalog. The interface declares that consumption (usedBy epod-deployer) but no code implements it yet."
     },
     {
      "name": "write-links",
      "status": "skipped",
      "detail": "Nothing matched, so no link to write."
     },
     {
      "name": "check",
      "status": "succeeded",
      "detail": "declaredWithoutCallSite: epod/storefront-graphql (usedBy epod-deployer). The consumption is kept on purpose: the deployer is being built under catalog-api ISS-1 (REQ-1). Links get written once that code lands on dev."
     },
     {
      "name": "publish-role",
      "status": "succeeded",
      "detail": "catalog-api publishes nothing"
     }
    ],
    "stepsStale": false,
    "supersededBy": null,
    "findings": 10,
    "links": 0,
    "createdAt": "2026-10-06T00:33:47.973Z",
    "updatedAt": "2026-10-06T01:04:21.945Z"
   }
  },
  {
   "id": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "slug": "catalog-fe",
   "name": "Catalog FE",
   "builder": {
    "id": "0cb318b3-b81a-4a9f-aa62-669999e06714",
    "trigger": {
     "kind": "joined",
     "sha": "c2dc67ab971ea9dc3a1c14e88779d9a6e461abce",
     "head": {
      "ref": "refs/heads/release/stg",
      "readAt": "2026-10-06T02:00:44.000Z",
      "via": "runner-checkout"
     }
    },
    "steps": [
     {
      "name": "read-repo",
      "status": "succeeded",
      "detail": "Read at c2dc67ab (release/stg): Vite/React SPA; every backend call goes through utils/fetcher axiosInstance (baseURL VITE_APP_API_URL), plus one raw axios PUT to a presigned upload URL."
     },
     {
      "name": "find-outbound-calls",
      "status": "succeeded",
      "detail": "244 call sites at c2dc67ab, all classified unknown: 243 to VITE_APP_API_URL (240 via utils/fetcher axiosInstance, 3 raw axios with ${API_URL}); all /api/v1/* except one /replace-edit-sku-name and 3 dynamic URLs on the same instance; 1 raw axios PUT to a presigned upload URL whose host exists only at runtime. Unknown rather than matched because catalog-api's api-page answers 403 to catalog-fe (agent report 940e8f72). counts={\"unknown\": 244}"
     },
     {
      "name": "match-contracts",
      "status": "succeeded",
      "detail": "Matched against catalog-api/admin-rest-v1 3.0.0 (approved; 10 operations, read from its published source docs/contracts/admin-rest-v1/openapi.yaml at catalog-api af816fcb): 24 call sites match 9 operations (getPlatform unused); 224 stay unknown — 223 call catalog-api /api/v1 operations 3.0.0 does not publish, 1 presigned upload."
     },
     {
      "name": "write-links",
      "status": "succeeded",
      "detail": "10 links, one per calling module (7 under src/apis/*, plus modules/catalog, modules/designs, modules/reports), pinned 3.0.0, state current, 24 call sites; each lists the catalog-api operations it calls outside the contract. fieldsUsed not traced yet."
     },
     {
      "name": "check",
      "status": "succeeded",
      "detail": "All 24 link call sites read back at c2dc67ab: each named line (or the 3 after it, for multi-line calls) holds its operation's path. Interface consumes catalog-api/admin-rest-v1 and links call it, so nothing is declared without a call site."
     },
     {
      "name": "publish-role",
      "status": "succeeded",
      "detail": "catalog-fe's role is consumer only: interface revision 1 declares consumes catalog-api/admin-rest-v1 builtAgainst 3.0.0 in ecosystem epod-catalog and publishes nothing; catalog-api's api-page lists catalog-fe as that contract's consumer."
     }
    ],
    "stepsStale": false,
    "supersededBy": null,
    "findings": 248,
    "links": 10,
    "createdAt": "2026-10-06T02:00:45.016Z",
    "updatedAt": "2026-10-06T04:41:53.907Z"
   }
  },
  {
   "id": "73371520-e588-4540-a9b6-5b992344791d",
   "slug": "epod",
   "name": "ePOD (epodsystem-core)",
   "builder": {
    "id": "5c744700-c9fd-4291-9617-912c2672042c",
    "trigger": {
     "kind": "joined",
     "sha": "76fa130dfe2f1f970805356a96221c10c0bf006f",
     "head": {
      "ref": "refs/heads/dev",
      "readAt": "2026-10-06T00:33:47.000Z",
      "via": "runner-checkout"
     }
    },
    "steps": [
     {
      "name": "read-repo",
      "status": "succeeded",
      "detail": "read at 76fa130d on refs/heads/dev from the bound checkout; HEAD, dev and origin/dev all resolve to it"
     },
     {
      "name": "find-outbound-calls",
      "status": "succeeded",
      "detail": "swept backend-go, frontend, mcp, cli, ai-langgraph, mobile at 76fa130d (tests, fixtures, seeders, benchmarks excluded); 21 findings. Not recorded as findings: infra (Postgres, Redis, Elasticsearch, Kafka/Kafka Connect, SMTP, DNS) and this project's own components calling each other (frontend/cli/mobile/ai-langgraph/ccrun -> Go backend GraphQL and /api/ai/*, Next.js revalidate and Liquid validator, Varnish purge, headless Chrome sidecar, LangGraph self-call). No code references catalog-api, any CATALOG_* setting, or another sidcorp ecosystem project (searched catalog[-_]api, CATALOG_*, catalog-service, sidcorp, eco-epod, epod-catalog, forge); the only 'catalog' names are this project's own internal/catalog, dbz-catalog CDC and page-catalog."
     },
     {
      "name": "match-contracts",
      "status": "succeeded",
      "detail": "0 matched. No finding targets an ecosystem member: 12 are outside_ecosystem third-party hosts and 9 unknown (env-configured vendor or runtime/merchant-set hosts). The published contracts list itself was not readable: GET /api/ecosystems/<id> refuses this pane's token PAT_ACCOUNT_ROUTE (fenced to projects), and catalog-api's api-page refuses FORBIDDEN (no link yet). With no call aimed at any ecosystem project, there was nothing to match against it."
     },
     {
      "name": "write-links",
      "status": "skipped",
      "detail": "no matched finding, so no link to write; links stays empty"
     },
     {
      "name": "check",
      "status": "succeeded",
      "detail": "report.declaredWithoutCallSite is [] at revision 4; the interface is undeclared (GET /interface: declared=false), so it declares no consumption a link would owe; links=[] agrees with 0 matched findings"
     },
     {
      "name": "publish-role",
      "status": "succeeded",
      "detail": "interface revision 1 (2026-10-06T00:41:00Z, set by a person) publishes storefront-graphql (graphql, upload) in ecosystem 58c8e969, commitments semver / 30d notice / rfi 3d / change-request 5d; contract version 1.0.0 recorded from backend-go/gqlgen.yml@76fa130d (sha256 2a532f46…) and approved 00:41:27Z. Not re-declared by this master; its own PUT at baseRevision null was refused SCHEMA_VIOLATION and wrote nothing."
     }
    ],
    "stepsStale": false,
    "supersededBy": null,
    "findings": 21,
    "links": 0,
    "createdAt": "2026-10-06T00:33:47.233Z",
    "updatedAt": "2026-10-06T01:04:09.408Z"
   }
  }
 ],
 "contracts": [
  {
   "provider": "73371520-e588-4540-a9b6-5b992344791d",
   "slug": "storefront-graphql",
   "title": "ePOD storefront and admin GraphQL API",
   "type": "graphql",
   "lifecycle": "production",
   "currentVersion": "1.2.0"
  },
  {
   "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
   "slug": "admin-rest-v1",
   "title": "catalog-api admin REST (/api/v1)",
   "type": "openapi",
   "lifecycle": "production",
   "currentVersion": "3.2.0"
  }
 ],
 "links": [
  {
   "id": "d4e0ff8d-9b42-483f-8b68-4340197c1ad1",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "modules/designs",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 3,
   "impact": {
    "link": "d4e0ff8d-9b42-483f-8b68-4340197c1ad1",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "modules/designs",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "a4b7bc35-181b-40ef-8048-312efc27ea51",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "modules/catalog",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 0,
   "impact": {
    "link": "a4b7bc35-181b-40ef-8048-312efc27ea51",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "modules/catalog",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "0d39f604-d80f-472c-a9f6-a045366f7d50",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "modules/reports",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 0,
   "impact": {
    "link": "0d39f604-d80f-472c-a9f6-a045366f7d50",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "modules/reports",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "31e6a58d-ce3a-45ff-b99a-29aa9479f5d7",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/catalog",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 41,
   "impact": {
    "link": "31e6a58d-ce3a-45ff-b99a-29aa9479f5d7",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/catalog",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "d4b6ce46-9ef0-4e9e-8c13-d7bfdf7a50ab",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/catalog-content",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 3,
   "impact": {
    "link": "d4b6ce46-9ef0-4e9e-8c13-d7bfdf7a50ab",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/catalog-content",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "0bac9d6b-0d7d-4e56-811c-f1945288a4a0",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/common",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 18,
   "impact": {
    "link": "0bac9d6b-0d7d-4e56-811c-f1945288a4a0",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/common",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "ae4b0510-59cb-4848-b8a2-23478426bbbd",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/get-store-detail",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 0,
   "impact": {
    "link": "ae4b0510-59cb-4848-b8a2-23478426bbbd",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/get-store-detail",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "8fb4f2eb-9090-47eb-a096-f703b9cca455",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/get-store-list",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 0,
   "impact": {
    "link": "8fb4f2eb-9090-47eb-a096-f703b9cca455",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/get-store-list",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "a670264a-4774-4019-a662-db6a1fcf4fee",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/report",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 12,
   "impact": {
    "link": "a670264a-4774-4019-a662-db6a1fcf4fee",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/report",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  {
   "id": "605fcc21-49cf-4a3d-8d7b-6f1afecd9c5e",
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "module": "apis/store",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "state": "current",
   "pinnedVersion": "3.2.0",
   "outsideContract": 26,
   "impact": {
    "link": "605fcc21-49cf-4a3d-8d7b-6f1afecd9c5e",
    "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "apis/store",
    "pinnedVersion": "3.2.0",
    "verdict": "passes",
    "reason": "built-against",
    "breaks": [],
    "version": "3.2.0"
   },
   "updatedAt": "2026-10-06T13:55:17.288Z"
  }
 ],
 "declared": [
  {
   "consumer": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
   "contract": {
    "provider": "73371520-e588-4540-a9b6-5b992344791d",
    "slug": "storefront-graphql"
   },
   "builtAgainst": "1.2.0",
   "usedBy": [
    "epod-deployer"
   ],
   "linked": false
  },
  {
   "consumer": "feaf7d40-de68-4b08-a797-4eccfe64b959",
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "builtAgainst": "3.0.0",
   "usedBy": [
    "catalog-fe"
   ],
   "linked": true
  }
 ]
});

export const AUTOFLOW = wire<Bus>({
 "ecosystem": {
  "id": "98600895-a0c2-4939-b3e9-80d6a5343434",
  "slug": "autoflow",
  "name": "Autoflow"
 },
 "projects": [
  {
   "id": "edc4e80d-5c2a-40d6-b5f0-80e9fe431345",
   "slug": "autoflow",
   "name": "Autoflow core",
   "builder": {
    "id": "8402382b-87b3-488f-a431-37b16aa35574",
    "trigger": {
     "kind": "manual",
     "sha": "1810f843c4abd30d4d0bedc908cdb29d1db1f1a5"
    },
    "steps": [
     {
      "name": "read-repo",
      "status": "succeeded",
      "detail": "HEAD 1810f84, the same head run 6c2a2c57 read; opened by ISS-1 to record the provider role once the interface was declared."
     },
     {
      "name": "find-outbound-calls",
      "status": "succeeded",
      "detail": "Unchanged from run 6c2a2c57 at the same head: 20 outbound targets, 8 fixed third-party hosts and 12 resolved from config or input; its findings stand and are not re-listed."
     },
     {
      "name": "match-contracts",
      "status": "succeeded",
      "detail": "0 matched: no outbound call targets a contract another active member publishes in ecosystem Autoflow; autoflow's own shop-mcp and shop-mcp-graphql are its publications, never its consumptions."
     },
     {
      "name": "write-links",
      "status": "skipped",
      "detail": "No matched finding, so no link to write."
     },
     {
      "name": "check",
      "status": "succeeded",
      "detail": "links: 0; interface declared at revision 1 with consumes []; declaredWithoutCallSite empty."
     },
     {
      "name": "publish-role",
      "status": "succeeded",
      "detail": "Provider in ecosystem Autoflow: publishes autoflow/shop-mcp (mcp-tools, 1.0.0, backend-go/cmd/mcp@1810f843) and autoflow/shop-mcp-graphql (graphql, 1.0.0, backend-go/internal/pkg/graphql@1810f843); consumes nothing."
     }
    ],
    "stepsStale": false,
    "supersededBy": null,
    "findings": 0,
    "links": 0,
    "createdAt": "2026-10-02T10:51:34.706Z",
    "updatedAt": "2026-10-02T10:51:46.895Z"
   }
  },
  {
   "id": "d180bdca-a927-4b11-b370-fa2ec923dba4",
   "slug": "hop",
   "name": "HOP — Hospital Operations Platform",
   "builder": {
    "id": "c1c832e2-ddb2-49ac-8575-02691bd7af24",
    "trigger": {
     "kind": "manual",
     "sha": null,
     "source": "storefront"
    },
    "steps": [
     {
      "name": "read-storefront",
      "status": "succeeded",
      "detail": "Read autoflow store hop (storeId 11, backendResolvedLive true) on 2026-10-02: list_backend_workflows -> 0 workflows (so 0 nodes), list_backend_routes -> 0 routes."
     },
     {
      "name": "find-provider-usage",
      "status": "succeeded",
      "detail": "No workflow, route or node exists, so there is no outbound use to record: 0 findings."
     },
     {
      "name": "match-contracts",
      "status": "skipped",
      "detail": "Nothing to match: find-provider-usage recorded 0 uses."
     },
     {
      "name": "write-links",
      "status": "skipped",
      "detail": "No matched use, so no link to create; forge_ecosystem links for hop reads 0 links."
     },
     {
      "name": "check",
      "status": "succeeded",
      "detail": "Interface not declared (declared:false), 0 links, 0 findings; report.declaredWithoutCallSite is empty, so no declared consumption stands without a call site."
     },
     {
      "name": "publish-role",
      "status": "skipped",
      "detail": "hop has no declared interface, and writing one is an admin's (interface_write), not this master's. With nothing built on the storefront, there is no role to publish yet."
     }
    ],
    "stepsStale": false,
    "supersededBy": null,
    "findings": 0,
    "links": 0,
    "createdAt": "2026-10-02T08:19:27.127Z",
    "updatedAt": "2026-10-02T08:20:38.914Z"
   }
  }
 ],
 "contracts": [
  {
   "provider": "edc4e80d-5c2a-40d6-b5f0-80e9fe431345",
   "slug": "shop-mcp",
   "title": "Shop MCP tools",
   "type": "mcp-tools",
   "lifecycle": "production",
   "currentVersion": "1.0.0"
  },
  {
   "provider": "edc4e80d-5c2a-40d6-b5f0-80e9fe431345",
   "slug": "shop-mcp-graphql",
   "title": "Shop MCP GraphQL operations",
   "type": "graphql",
   "lifecycle": "production",
   "currentVersion": "1.0.0"
  }
 ],
 "links": [],
 "declared": []
});

export const CATALOG_API_RUN = wire<BuilderRunRecord>({
 "revision": 5,
 "writer": "e78076cd-d3ec-43d6-bf76-1ff57a86df7a",
 "document": {
  "ecosystem": "58c8e969-38e6-466d-b9a6-256bc68d7c26",
  "project": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
  "trigger": {
   "kind": "joined",
   "sha": "fe1158c15bc5e6dff4660e0ecee90b0fbc2dd2cd",
   "head": {
    "ref": "refs/heads/dev",
    "readAt": "2026-10-06T00:33:47.000Z",
    "via": "runner-checkout"
   }
  },
  "steps": [
   {
    "name": "read-repo",
    "status": "succeeded",
    "detail": "Read refs/heads/dev at fe1158c1 (app/, config/, routes/, docs/architecture/catalog-integrations.json)."
   },
   {
    "name": "find-outbound-calls",
    "status": "succeeded",
    "detail": "10 outbound uses, none to an ecosystem member. No file on any branch calls ePOD (apiKeyContext, assignProductToStores, setProductStoreVisibility and 'epod' grep empty at fe1158c1)."
   },
   {
    "name": "match-contracts",
    "status": "succeeded",
    "detail": "No use matches epod/storefront-graphql 1.0.0, the only contract published in epod-catalog. The interface declares that consumption (usedBy epod-deployer) but no code implements it yet."
   },
   {
    "name": "write-links",
    "status": "skipped",
    "detail": "Nothing matched, so no link to write."
   },
   {
    "name": "check",
    "status": "succeeded",
    "detail": "declaredWithoutCallSite: epod/storefront-graphql (usedBy epod-deployer). The consumption is kept on purpose: the deployer is being built under catalog-api ISS-1 (REQ-1). Links get written once that code lands on dev."
   },
   {
    "name": "publish-role",
    "status": "succeeded",
    "detail": "catalog-api publishes nothing"
   }
  ],
  "findings": [
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/BigcommerceService.php",
     "line": 15,
     "operation": "BigCommerce REST: deploy/update/delete products"
    },
    "host": "api.bigcommerce.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/ShopifyService.php",
     "line": 18,
     "operation": "Shopify Admin API: deploy/update/delete products"
    },
    "host": "myshopify.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/ShopBaseService.php",
     "line": 11,
     "operation": "ShopBase API"
    },
    "host": "onshopbase.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/DodgeprintService.php",
     "line": 23,
     "operation": "Dodgeprint API: deploy/delete products"
    },
    "host": "stg-api.dodgeprint.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/HubService.php",
     "line": 9,
     "operation": "AdminHub: pull sites and users"
    },
    "host": "adminhub-api.canawan.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/NocodbService.php",
     "line": 25,
     "operation": "NocoDB: hourly pull"
    },
    "host": "nocodb.canawan.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/N8NService.php",
     "line": 9,
     "operation": "n8n webhook alerts"
    },
    "host": "it-n8n.canawan.com"
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/GoogleSheet.php",
     "line": 36,
     "operation": "Google Sheets/Drive feeds"
    },
    "host": "sheets.googleapis.com"
   },
   {
    "classification": "unknown",
    "site": {
     "path": "app/Services/MagentoService.php",
     "line": 21,
     "operation": "Magento REST: deploy/update/delete products"
    },
    "note": "Host is each site's endpoint from manage_big_com_sites, synced from AdminHub; no fixed host in code."
   },
   {
    "classification": "outside_ecosystem",
    "site": {
     "path": "app/Services/SidcorpOidcService.php",
     "line": 80,
     "operation": "OIDC token exchange"
    },
    "host": "auth.sidcorp.co"
   }
  ],
  "links": [],
  "id": "6e100b43-3009-481b-bcfa-cc168c236139",
  "createdAt": "2026-10-06T00:33:47.973Z",
  "updatedAt": "2026-10-06T01:04:21.945Z"
 }
});

export const GUIDES = wire<Record<string, LinkRecord>>({
 "a4b7bc35-181b-40ef-8048-312efc27ea51": {
  "revision": 3,
  "writer": "6bdd2f2d-96b0-4018-9668-d58ae9f33207",
  "document": {
   "ecosystem": "58c8e969-38e6-466d-b9a6-256bc68d7c26",
   "consumer": {
    "project": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "modules/catalog"
   },
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "pinnedVersion": "3.2.0",
   "state": "current",
   "callSites": [
    {
     "path": "src/modules/catalog/components/product-catalog-component/field-filter.tsx",
     "line": 123,
     "operation": "GET /api/v1/sites"
    }
   ],
   "fieldsUsed": [],
   "outsideContract": [],
   "notes": [
    "Matched by method and path template at c2dc67ab by the catalog-fe master; fieldsUsed not traced yet.",
    "Re-pinned 3.0.0 -> 3.1.1 (additive; no operation this module calls changed)."
   ],
   "writtenBy": {
    "sha": "c2dc67ab971ea9dc3a1c14e88779d9a6e461abce"
   },
   "refreshedAtSha": "c2dc67ab971ea9dc3a1c14e88779d9a6e461abce",
   "id": "a4b7bc35-181b-40ef-8048-312efc27ea51",
   "createdAt": "2026-10-06T04:40:51.805Z",
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  "currentVersion": "3.2.0"
 },
 "d4e0ff8d-9b42-483f-8b68-4340197c1ad1": {
  "revision": 3,
  "writer": "6bdd2f2d-96b0-4018-9668-d58ae9f33207",
  "document": {
   "ecosystem": "58c8e969-38e6-466d-b9a6-256bc68d7c26",
   "consumer": {
    "project": "feaf7d40-de68-4b08-a797-4eccfe64b959",
    "module": "modules/designs"
   },
   "contract": {
    "provider": "9208f825-a431-430e-8de1-b4cb3ccc45b1",
    "slug": "admin-rest-v1"
   },
   "pinnedVersion": "3.2.0",
   "state": "current",
   "callSites": [
    {
     "path": "src/modules/designs/auto-deploy/api/create-auto-deploy-catalog-design/index.ts",
     "line": 9,
     "operation": "POST /api/v1/catalog-designs/deploy"
    },
    {
     "path": "src/modules/designs/list/design-filter-fields.tsx",
     "line": 106,
     "operation": "GET /api/v1/sites"
    }
   ],
   "fieldsUsed": [],
   "outsideContract": [
    "GET /api/v1/catalog-designs",
    "GET /api/v1/catalog-designs/X",
    "PUT /api/v1/catalog-designs/X"
   ],
   "notes": [
    "Matched by method and path template at c2dc67ab by the catalog-fe master; fieldsUsed not traced yet.",
    "Re-pinned 3.0.0 -> 3.1.1 (additive; no operation this module calls changed)."
   ],
   "writtenBy": {
    "sha": "c2dc67ab971ea9dc3a1c14e88779d9a6e461abce"
   },
   "refreshedAtSha": "c2dc67ab971ea9dc3a1c14e88779d9a6e461abce",
   "id": "d4e0ff8d-9b42-483f-8b68-4340197c1ad1",
   "createdAt": "2026-10-06T04:40:50.980Z",
   "updatedAt": "2026-10-06T13:55:17.288Z"
  },
  "currentVersion": "3.2.0"
 }
});
