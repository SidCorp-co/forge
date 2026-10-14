---
title: Connect another app
section: Connect an assistant
order: 50
audience: assistant-setup
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

1. In Forge, select your initials at the bottom of the left-hand menu.

   **Check:** a short menu opens, with **Account & Settings** in it.

2. Choose **Account & Settings**.

   **Check:** the Settings page opens, with tabs along the top that include
   **API Tokens** and **MCP**.

3. Choose the **API Tokens** tab.

   **Check:** a list titled **Your tokens** is at the top of the tab.

4. Scroll down, below **Your tokens**, to the form titled **Create a token**.

   **Check:** the form's first box, **Name**, is in view.

5. In **Name**, type the name of your app.

   **Check:** the name shows in the box.

6. Under **Scopes**, tick **write**; **read** is already ticked for you. Read lets
   the assistant look things up; write lets it make changes for you, such as filing
   an issue or adding a comment.

   **Check:** both **read** and **write** are ticked.

7. Under **Permissions**, choose **Only the permissions I pick**.

   **Check:** a list of permissions, each with a box, appears under that choice, and
   none of them is ticked.

8. Tick `issues:read`. The form needs at least one permission, and these permissions
   limit a different way into Forge from the one your assistant uses, so the
   smallest one is enough. What your assistant may do is set by **Scopes** and by
   **Bind to a project**.

   **Check:** `issues:read` is the only permission ticked.

9. In **Bind to a project**, choose the project you want to ask about. The token
   then works for that project only.

   **Check:** the box shows the project's name.

10. Choose **Create token**.

    **Check:** a panel titled **Token created** appears; or, if Forge wants to
    confirm it is you first, a **Confirm password** box or a **Continue with**
    button appears instead.

11. If the **Token created** panel has not appeared, follow
    **If Forge asks you to confirm it is you** at the end of this page. You come
    back to step 12 when the panel is showing.

    **Check:** the panel titled **Token created** shows a long code that starts with
    `forge_pat_`.

12. Choose **Copy to clipboard**. Forge shows the code only this once.

    **Check:** a notice reading **Copied to clipboard** appears.

13. Paste the code into your note.

    **Check:** your note holds the whole code, starting with `forge_pat_`.

14. Choose **Done** to close the panel.

    **Check:** you are back on the **API Tokens** tab, and your new token is listed
    under **Your tokens**.

15. Choose the **MCP** tab.

    **Check:** a card titled **Connect a client** shows an **Endpoint** and a
    **Project**.

16. In **Project**, choose the project you chose in step 9. It may already be
    showing.

    **Check:** under **Config snippet**, a sentence reads
    *"This snippet configures"*, then your project's name, then a short grey label —
    the project's short name.

17. Copy the address under **Endpoint**.

    **Check:** the address is highlighted.

18. Paste the address into your note.

    **Check:** your note holds an address that starts with `https://` and ends with
    `/mcp`.

19. Copy the grey short name.

    **Check:** the short name is highlighted.

20. Paste the short name into your note.

    **Check:** your note holds the token, the address and the short name.

21. In your app, open the place where it lists connected services. Its label is
    often **MCP**, **MCP servers**, **Connectors**, **Tools** or **Integrations**.

    **Check:** you see a list of connected services, or a button to add one.

22. Choose to add a new connected service.

    **Check:** the app asks which kind to add, asks for a name and an address, or
    asks you to paste a block of settings.

23. If the app asks which kind to add, choose the kind that connects to an address —
    often called **Streamable HTTP**, **HTTP**, **Remote** or **URL**.

    **Check:** if the app has such a kind, it now asks for a name and an address.

24. If your app offers only a kind that starts a program (**Command** or **stdio**),
    follow **If your app only starts programs** at the end of this page. You go on
    to step 38 when you have finished it.

    **Check:** if you followed it, your app shows the settings you gave it, with
    your token in them.

25. If your app asked you to paste a block of settings, follow
    **If your app asks for a block of settings** at the end of this page. You go on
    to step 38 when you have finished it.

    **Check:** if you followed it, your app shows the block, with your token in it.

26. For the name, type `forge`.

    **Check:** the name box shows `forge`.

27. Copy the address from your note.

    **Check:** the address is highlighted.

28. Paste the address into the address box.

    **Check:** the address box shows the address ending in `/mcp`.

29. Choose to add a header. Apps label it **Add header**, **Headers** or a **+**
    beside **Headers**.

    **Check:** the app shows an empty box for the header's name and one for its
    value.

30. In the header's name box, type `Authorization`.

    **Check:** the name box shows `Authorization`.

31. In the header's value box, type `Bearer` followed by one space.

    **Check:** the value box shows `Bearer`, with the cursor one space after it.

32. Copy the code from your note.

    **Check:** the code is highlighted.

33. Paste the code into the value box, after the space.

    **Check:** the value reads `Bearer forge_pat_…`, with your token where the dots
    are.

34. Choose to add a second header.

    **Check:** a second pair of empty boxes appears, for a name and a value.

35. In the new header's name box, type `X-Forge-Project-Slug`.

    **Check:** the name box shows `X-Forge-Project-Slug`.

36. Copy the short name from your note.

    **Check:** the short name is highlighted.

37. Paste the short name into the new header's value box.

    **Check:** two headers are listed, `Authorization` and `X-Forge-Project-Slug`,
    each with its value.

38. Save.

    **Check:** **forge** is listed, or your app asks you to restart it.

39. If your app asks you to restart, restart it.

    **Check:** **forge** is listed as connected, and your app shows its tools or a
    count of them.

40. Start a new chat.

    **Check:** the new chat is empty and waiting for your question.

41. Type: *"What issues are open in Forge right now?"*

    **Check:** your question shows where you type, and it has not been sent yet.

42. Send the question. Most apps send it when you press Enter.

    **Check:** your app asks permission to use a tool from `forge`, or goes straight
    to an answer.

43. If your app asked permission, allow it.

    **Check:** the answer names issues from your project.

44. Delete the note. The token now lives in your app's settings, and you will not
    need the copy again.

    **Check:** the note is gone from your notes app.

## If Forge asks you to confirm it is you

Forge sometimes checks that it is really you before it makes a token. After
step 10 you see either a **Confirm password** box or a **Continue with** button
instead of the **Token created** panel. Do the part below that matches what you
see. Either way you finish with the **Token created** panel, and then you go on
to step 12.

If you see a **Confirm password** box:

1. Type the password you sign in to Forge with into the **Confirm password** box.

   **Check:** the box shows dots, one for each character you typed.

2. Choose **Confirm & create**.

   **Check:** a panel titled **Token created** shows a long code that starts with
   `forge_pat_`.

If you see a **Continue with** button:

1. Choose **Continue with** your sign-in provider.

   **Check:** your sign-in provider's own page opens.

2. Sign in there.

   **Check:** you are back on Forge's **API Tokens** tab, with the form as you
   left it.

3. Choose **Create token** again.

   **Check:** a panel titled **Token created** shows a long code that starts with
   `forge_pat_`.

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

## If your app asks for a block of settings

1. In Forge, choose the **Generic** tab above the snippet on the **MCP** tab.

   **Check:** the snippet is a block of settings that holds `<YOUR_TOKEN_HERE>`.

2. Choose **Copy**.

   **Check:** the button changes to **Copied ✓**.

3. Paste the block into your app's box for it.

   **Check:** the box shows the block.

4. In the block, replace `<YOUR_TOKEN_HERE>` with your token, keeping the word
   `Bearer` and the space after it.

   **Check:** no `<` or `>` is left in the block.

## If something goes wrong

See [When it does not work](?path=connect-an-assistant/when-it-does-not-work).
Many apps show the reason next to the service's name in their list.
