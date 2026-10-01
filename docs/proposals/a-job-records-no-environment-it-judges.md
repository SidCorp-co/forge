# A job records no environment it judges

`GET /api/jobs/self/testing-profiles/<profile>/secrets` hands a running job the values behind the
testing profile of the environment it judges
(`packages/core/src/project-config/testing-secrets.ts:resolveTestingSecrets`). Nothing on a job
says which environment that is. `jobs` has no environment column, the payload a dispatcher writes
carries none, and `{{project:test-creds}}` lists every environment's profile to every job.

So the route can name the environment only where the project document leaves one candidate: exactly
one environment names a testing profile. Where two or more do, it refuses with
`TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS` and lists them, rather than handing out one environment's
logins to a job judging another. forge-dev names a profile on both `dev` and `beta`, so every resolve
there is refused today.

This needs a person's decision, because whoever records the environment is the one the route trusts:

| Choice | What it costs, and who pays |
|---|---|
| The dispatcher records the environment on the job when it creates it | A new kernel field, written by core's dispatch and by forge-plugin's `forge claim`. Both repositories change, on different clocks. |
| Core derives it from where the issue's landed commit is served | It needs a live deployment read at resolve time. When that read fails, the job cannot log in. |
| One testing profile per project | Projects with a staging login and a production login cannot be tested unattended. |

## Honest costs

- Until a person picks a row, a project whose document names more than one testing profile gets no
  unattended login. An acceptance criterion behind a login is walked by hand there.
