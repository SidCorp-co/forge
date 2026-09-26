---
title: When it does not work
section: Connect an assistant
order: 70
---

# When it does not work

Five things go wrong when connecting an assistant to Forge. Each section below
says what you see and how to fix it. Start with the one whose description
matches your screen.

Where a fix asks you to look at a file, it is the same file the setup page for
your app had you edit:
[Claude Desktop](?path=connect-an-assistant/claude-desktop),
[Cursor](?path=connect-an-assistant/cursor) or
[another app](?path=connect-an-assistant/other-apps). For
[Claude Code](?path=connect-an-assistant/claude-code) there is no file — you
remove the connection with `claude mcp remove forge -s user` and run the
corrected line again.

## A placeholder is still in the settings

The settings Forge writes for you hold `<YOUR_TOKEN_HERE>` where your token
goes, and the Claude Desktop page adds `<ENDPOINT>` and `<PROJECT>`. If one of
them was not replaced, Forge has nothing it can check.

**What you see**

- Claude Code: `claude mcp list` shows `✘ Failed to connect`, and the words after
  it say the settings still hold a placeholder.
- Claude Desktop, Cursor and other apps: **forge** is marked as failed or
  disconnected in the app's list of connected services.

**The fix**

Look for `<` or `>` in the settings. Replace each placeholder, angle brackets
included, with your token, the address, or the project's short name from the
**MCP** tab. Keep the word `Bearer` and the space after it in front of the
token. Save, then quit and reopen the app.

## The token was copied wrong, revoked or has expired

**What you see**

- Claude Code: `claude mcp list` shows `✘ Failed to connect` and `HTTP 401`, with
  the words `invalid personal access token` in the detail.
- Other apps: **forge** is marked as failed. Claude Desktop's log for Forge
  mentions `401` or `Dynamic Client Registration rejected`.

**The fix**

1. In Forge, open **Account & Settings** › **API Tokens** and find the token
   under **Your tokens**. If its **Expires** date has passed or its name is
   followed by *(revoked)*, it no longer works.
2. Create a new token, as in the setup page for your app, and copy it whole — it
   starts with `forge_pat_` and has no spaces in it. Give it a name no active
   token has, or choose **Revoke** on the old one first: Forge refuses a second
   active token with the same name.
3. Put the new token in place of the old one, save, then quit and reopen the app.

## Forge answers, but not about your project

**What you see**

The assistant connects, but when it tries to look something up it reports that
the project was *not found* or is *not accessible*.

**The fix**

- On Forge's **MCP** tab, read the project's short name in the grey label, and
  check that your settings use exactly that — the short name, not the full name.
- If you bound the token to a project, its row under **Your tokens** shows
  **Project:** and a short name in the **Level** column. It must be the same
  project.
- If the project does not appear in Forge for you at all, you are not a member
  yet. Ask whoever runs the project to add you.

## The app does not show forge at all

**What you see**

- Claude Desktop: **Settings** › **Developer** does not list **forge**, or
  Claude shows a message that it could not read its settings file.
- Cursor: **forge** is missing from the list in Cursor Settings.

**The fix**

1. Quit the app completely and open it again. Closing its window is not enough:
   on a Mac, use the app's menu in the menu bar and choose **Quit**; on Windows,
   right-click its icon near the clock and choose **Quit**.
2. If it is still missing, open the settings file again and check it against the
   block on the setup page. The three usual mistakes:
   - **Curly quotes.** Every quote mark must be a straight `"`. TextEdit on a Mac
     can turn them curly as you type — turn that off in **Edit** ›
     **Substitutions** › **Smart Quotes**, then retype the quote marks.
   - **A missing comma** between the `forge` block and another connection
     listed next to it.
   - **The block pasted outside** `"mcpServers": { … }`. The word `forge` must
     sit inside it.
3. Save, then quit and reopen the app.

## Claude Desktop cannot start its helper

This one affects Claude Desktop and any other app set up with the helper
program.

**What you see**

**forge** is listed under **Settings** › **Developer** but marked as failed, and
its log mentions `npx` — for example `spawn npx ENOENT` or *"npx is not
recognized"*.

**The fix**

1. Install **Node.js**: download the **LTS** installer from `https://nodejs.org`
   and run it, keeping every choice as it is.
2. Restart the computer, so Claude Desktop finds the newly installed program.
3. Open Claude Desktop and check **Settings** › **Developer** again.

## Still stuck

Claude Desktop keeps a log for each connection. On a Mac, in Finder choose
**Go** › **Go to Folder…** and paste `~/Library/Logs/Claude/`; on Windows, paste
`%APPDATA%\Claude\logs\` into File Explorer's address bar. The file for Forge is
called `mcp-server-forge.log`.

When you ask someone for help, send them what your app shows next to **forge**,
or the last lines of that log. Never send the token itself — it works like your
password. If you think a token has been seen by someone else, revoke it on the
**API Tokens** tab and create a new one.
