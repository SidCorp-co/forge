# Three SQL sweeps still read a stored pipelineConfig the schema refuses

Found by ISS-1368. That issue made every TypeScript reader of `agent_config.pipelineConfig`
refuse a refused document by name (`pipeline/stored-pipeline-config.ts:readStoredPipelineConfig`,
`PIPELINE_CONFIG_UNREADABLE`) and named every such project at boot
(`pipeline/orchestrator.ts:reportUnreadablePipelineConfigs`). Three readers are left out. Each
reads one key inside a SQL predicate that runs across every project, where the schema cannot run:

- `jobs/park-deadline.ts:RESIDENCY_DEADLINE` reads `sessionResidencySeconds` with `::int`.
- `pipeline/inv7-alarms.ts` reads `reopenPolicy.noProgressRounds` with `::int`, as the alarm's
  threshold.
- `admin/alert-queries.ts` reads `states.<stage>.deviceIds` for the starved-project alert, and
  treats anything other than a non-empty array as "no pool".

What a refused value does today, read from the code:

- **An integer outside the schema's range** (residency over 3600, a threshold of 0) is used as
  stored, and nothing says so.
- **A non-integer** (a string, `1.5`) fails the cast. The whole sweep then errors for every
  project, and the project that caused it is not named.
- **A `deviceIds` that is not an array** reads as "no pool", which is a guess.

When the refused key is a different one (the likeliest case, a `releaseRuntimes` path), these
sweeps read a valid value. The only harm is that the refusal's own sentence ("nothing reads it")
is not true of them.

**Why this was not fixed in ISS-1368:** a per-project refusal inside a cross-project sweep has to
decide what the sweep does for that project, and the answers differ. Skipping a refused project in
the park reaper leaves its expired sessions holding device slots that other projects share.
Defaulting is the fallback the issue removes. Failing the sweep stops it for everyone. For the
two alerts, skipping the project and naming it is the shape `devices/admissible.ts:readAdmissions`
already uses.

**What it would take:** before each sweep's query, read the candidate projects' stored documents
in TypeScript and name each refused one through `refusedPipelineKeys`. Then pass the value each
predicate reads as a parameter, taken from the parsed config, instead of a JSONB path. A refused
project is excluded from the two alerts and reported. For the reaper, an owner decides between
reaping at the default residency, which is a reported normalization of a policy input under
`VISION: kernel-hard-policy-soft`, and not reaping at all.

## Honest costs

- Reading the documents in TypeScript before each sweep adds one read of every candidate project's
  `agent_config` to sweeps that run every tick. Today the value is a JSONB path inside one query.
- Whichever reaper answer is chosen costs something. Reaping at the default acts on a value the
  project did not store. Not reaping holds shared device slots until someone corrects the document.
- Until this lands, the refusal's sentence "nothing reads it" overstates the case for these three
  sweeps.
