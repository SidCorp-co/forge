## Google Sheets through Forge

The credential is a Google **service account** held by Forge. You never receive it, no MCP server config carries it, and nothing writes it to the box you are running on. `forge_google_sheets` resolves the project's binding server-side and core makes the Google call.

### The one thing that is not Forge's to fix
A service account reaches only the sheets that have been **shared with its `client_email`** — Viewer for reads, Editor for writes — exactly as if it were a colleague. A sheet nobody shared is a `403` however correct the credential is, and the refusal says so. `list` prints the `clientEmail` to share with; a human does the sharing in Google.

### Which spreadsheet a call is about
`spreadsheetId` is the segment between `/d/` and `/edit` in the sheet's URL. It is optional:
- omitted → the spreadsheet the project's binding declares as its **default**;
- given → that one, for this call only;
- neither → **refused**. No sheet is guessed, ever.

### Order of operations
1. `list` — is there a binding at all, is it on, which account, which default sheet.
2. `info` — the title and the **tab names**. Do this before naming a range: a range naming a tab that does not exist is refused by Google, not returned empty.
3. `read` — `range` in A1 notation (`Sheet1!A1:D50`, or a bare tab name for all of it). Trailing empty cells are not padded, so a short row comes back as a short array — index by header position you read, not by a length you assumed.

### Writing: `update` overwrites, `append` adds
- `update` replaces the cells of `range`. It inserts nothing: three rows written over a ten-row range leave rows four to ten exactly as they were. That is the trap — an `update` used to "replace the table" leaves the old tail behind.
- `append` adds rows after the last non-empty row of the table `range` names, and tells you the range it actually wrote.
- Values land as a person typing them would leave them: `2026-09-16` becomes a date, `=SUM(A1:A9)` becomes a formula. Send a leading apostrophe if you mean the literal text.

### A sheet is somebody's working document
Read before you write, and write the narrowest range that does the job. There is no undo through this tool; the undo is a person's, in Google's own version history.

### The five refusals, and what each one is asking you to do
- **no Google connection on this project** — nothing is bound. A human connects one in Settings → Integrations.
- **the binding is switched off** — it exists and somebody disabled it. Do not work around it; ask why.
- **no spreadsheet named and no default declared** — pass `spreadsheetId`, or ask for a default to be set.
- **Google rejected the service account** — the key was revoked or the account deleted. A human re-enters it; retrying cannot help.
- **Google refused the sheet** — the credential is fine and the sheet is not shared with `client_email`. This is the common one.

None of the five returns an empty success. If you got rows back, they came from Google.