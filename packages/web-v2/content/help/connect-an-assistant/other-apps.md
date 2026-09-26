---
title: Connect another app
section: Connect an assistant
order: 50
---

# Connect another app

Many assistant apps can connect to outside services — some chat apps, code
editors and command-line tools. If yours is not Claude Desktop, Claude Code or
Cursor, this page gives it what every such app needs from Forge. Your app's own
help pages say where in the app each piece goes; the steps below say what the
pieces are.

## What your app needs from Forge

| Piece | What it is | Where you get it |
|---|---|---|
| Address | Forge's connection address, ending in `/mcp` | **Endpoint** on Forge's **MCP** tab |
| Connection type | **Streamable HTTP** — some apps call it **HTTP** or **Remote** | always the same |
| Header `Authorization` | the word `Bearer`, a space, then your token | a token you create on the **API Tokens** tab |
| Header `X-Forge-Project-Slug` | the short name of the project to ask about | the grey label on the **MCP** tab |

## Before you start

- Your app is installed, you are signed in, and its help pages mention adding a
  connected server or tool.
- You can open the Forge project you want to ask about.
- Open a blank note to paste into as you go — **Notes** or **TextEdit** on a
  Mac, **Notepad** on Windows. You will delete it at the end.

## Steps

1. In Forge, select your initials at the bottom of the left-hand menu, then choose
   **Account & Settings**.

   **Check:** the Settings page opens, with tabs along the top that include
   **API Tokens** and **MCP**.

2. Choose the **API Tokens** tab.

   **Check:** a form titled **Create a token** is at the top.

3. In **Name**, type the name of your app.

   **Check:** the name shows in the box.

4. Under **Scopes**, tick both **read** and **write**. Read lets the assistant
   look things up; write lets it file issues and add comments for you.

   **Check:** both boxes are ticked.

5. In **Bind to a project**, choose the project you want to ask about. The token
   then works for that project only.

   **Check:** the box shows the project's name.

6. Choose **Create token**. If Forge asks for your password, type it and choose
   **Confirm & create**. If it offers **Continue with** your sign-in provider
   instead, choose that, sign in, and choose **Create token** again once you are
   back on this page.

   **Check:** a panel titled **Token created** shows a long code that starts with
   `forge_pat_`.

7. Choose **Copy to clipboard**, and paste the code into your note. Forge shows it
   only this once.

   **Check:** your note holds the whole code, starting with `forge_pat_`.

8. Choose **Done** to close the panel.

   **Check:** your new token is listed under **Your tokens**.

9. Choose the **MCP** tab.

   **Check:** a card titled **Connect a client** shows an **Endpoint** and a
   **Project**.

10. Make sure **Project** shows the project you chose in step 5, and choose it if
    it does not.

    **Check:** under **Config snippet**, a sentence reads *"This snippet
    configures"*, then your project's name, then a short grey label — the
    project's short name.

11. Copy the address under **Endpoint** into your note.

    **Check:** your note holds an address that starts with `https://` and ends
    with `/mcp`.

12. Copy the grey short name into your note.

    **Check:** your note holds the token, the address and the short name.

13. In your app, open the place where it lists connected services. Its label is
    often **MCP**, **MCP servers**, **Connectors**, **Tools** or
    **Integrations**.

    **Check:** you see a list of connected services, or a button to add one.

14. Choose to add a new one, and pick the kind that connects to an address —
    often called **Streamable HTTP**, **HTTP**, **Remote** or **URL**. If your app
    offers only a kind that starts a program (**Command** or **stdio**), follow
    **If your app only starts programs** below instead.

    **Check:** the app asks for a name and an address. (If it asks you to paste a
    block of settings instead, use the **Generic** tab on Forge's **MCP** tab:
    copy its block, replace `<YOUR_TOKEN_HERE>` with your token, paste it, and go
    on to step 19.)

15. For the name, type `forge`.

    **Check:** the name box shows `forge`.

16. For the address, paste the address from your note.

    **Check:** the address box shows the address ending in `/mcp`.

17. Add a header named `Authorization` whose value is `Bearer`, a space, and your
    token.

    **Check:** the value reads `Bearer forge_pat_…`, with your token where the
    dots are.

18. Add a second header named `X-Forge-Project-Slug` whose value is the short name
    from your note.

    **Check:** two headers are listed.

19. Save, and restart the app if it asks you to.

    **Check:** **forge** is listed as connected, and your app shows its tools or a
    count of them.

20. In a new chat, ask: *"What issues are open in Forge right now?"*

    **Check:** your app asks permission to use a tool from `forge`, or uses one;
    the answer names issues from your project.

21. Delete the note. The token now lives in your app's settings, and you will not
    need the copy again.

    **Check:** the note is gone from your notes app.

## If your app only starts programs

Some apps can only connect by starting a program on your computer. For those, use
the same small helper Claude Desktop uses: install **Node.js** from
`https://nodejs.org` (the **LTS** installer) first, then give your app:

| Setting | Value |
|---|---|
| Command | `npx` |
| Arguments, one per line | `-y` · `mcp-remote@0.14.3` · your address · `--header` · `Authorization:${AUTH_HEADER}` · `--header` · `X-Forge-Project-Slug:${FORGE_PROJECT}` |
| Environment variable `AUTH_HEADER` | `Bearer`, a space, and your token |
| Environment variable `FORGE_PROJECT` | the project's short name |

Type the two header arguments exactly as shown, with no space after the colon —
the helper fills in `${AUTH_HEADER}` and `${FORGE_PROJECT}` from the two
environment variables. [Connect Claude Desktop](?path=connect-an-assistant/claude-desktop)
shows the same settings written out in full.

## If something goes wrong

See [When it does not work](?path=connect-an-assistant/when-it-does-not-work).
Many apps show the reason next to the service's name in their list.
