# A testing profile names secrets no run can read

ISS-12 deleted `projects.environments.testCredentials`. A tester's login used to sit in that
viewer-readable field, and `forge_projects.get` handed it to every run in plain text. The way in
is now the testing profile an environment names (`environments.<name>.testing`). Each actor and
service in the profile carries a `secret://<scope>/<name>` reference. The value behind it is
written with `PUT /api/projects/:id/secrets/:scope/:name` and held encrypted in `project_secrets`.

Design D3 keeps the config to `secret://` references, with the values in core's vault. No route or
tool reads a value back: `GET /api/projects/:id/secrets` lists names only. So a run told by `{{project:test-creds}}` which
profile its environment uses can read the references but cannot log in with them. Before ISS-12 a
run could log in, because the credential was in a field anyone could read.

This needs a person's decision, and that is why it is a line here rather than a fix:

| Choice | What it costs, and who pays |
|---|---|
| A resolve read limited to a run's own job credential and to the profile its environment names | A secret value leaves the vault for every QA run. The audit row and the scrubber become the only protection. Whoever writes the route owns the leak surface. |
| The runner resolves the reference on the box, from its own store | No value crosses core, but each box must be given the secrets out of band. An operator pays this per box. |
| Leave it: testers log in by hand | Runs that walk an acceptance criterion behind a login cannot run unattended, and every such project pays this in `needs_info` turns. |
