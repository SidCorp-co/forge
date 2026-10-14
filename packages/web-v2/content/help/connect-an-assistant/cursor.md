---
title: Connect Cursor
section: Connect an assistant
order: 40
audience: assistant-setup
---

# Connect Cursor

Cursor is a code editor with an assistant built in. This page connects that
assistant to one of your Forge projects: you create a token in Forge, copy the
settings Forge writes for you, and paste them into Cursor.

## Before you start

- Cursor is installed and you are signed in.
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

5. In **Name**, type `Cursor`.

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
    *"This snippet configures"* followed by your project's name.

17. Choose the **Cursor** tab above the snippet.

    **Check:** the words above the snippet name the file `~/.cursor/mcp.json`.

18. Choose **Copy**.

    **Check:** the button changes to **Copied ✓**.

19. Paste the snippet into your note, under the code.

    **Check:** your note holds the code and, below it, a block that starts with `{`
    and contains `"mcpServers"`.

20. In the block, replace `<YOUR_TOKEN_HERE>` — angle brackets included — with the
    code from step 13, keeping the word `Bearer` and the space after it.

    **Check:** the line reads `"Authorization": "Bearer forge_pat_…"` with your code
    where the dots are, and no `<` or `>` is left in the block.

21. Open Cursor's settings. On a Mac, press **Cmd+Shift+J**. On Windows, press
    **Ctrl+Shift+J**.

    **Check:** a page titled **Cursor Settings** opens.

22. Choose the section named **MCP** in the list on the left — in some versions it
    is called **Tools & MCP**.

    **Check:** the page lists connected services, or says there are none yet.

23. Choose the button that adds a new server — **Add Custom MCP** or
    **New MCP Server**, depending on your version.

    **Check:** Cursor opens a file called `mcp.json` in an editor tab. It is
    `~/.cursor/mcp.json`: on a Mac, the `.cursor` folder inside your home folder; on
    Windows, `C:\Users\<your name>\.cursor\mcp.json`.

24. If the file is empty, or holds only `{}` or `"mcpServers": {}` with nothing
    between those last braces, select everything in it — **Cmd+A** on a Mac,
    **Ctrl+A** on Windows.

    **Check:** if you did, everything in the editor tab is highlighted.

25. If you selected everything, paste the block from your note in its place.

    **Check:** if you did, the file holds `"forge"` inside `"mcpServers"`, with your
    token in it.

26. If the file already listed other servers under `"mcpServers"` when Cursor opened
    it, follow **If the file already lists other servers** at the end of this page.
    You go on to step 27 when you have finished it.

    **Check:** the file holds `"forge"` inside `"mcpServers"`, with your token in
    it.

27. Save the file — **Cmd+S** on a Mac, **Ctrl+S** on Windows.

    **Check:** the editor tab no longer marks the file as changed.

28. Go back to the **Cursor Settings** tab.

    **Check:** **forge** is listed.

29. If a switch beside **forge** is off, turn it on.

    **Check:** **forge** shows a green dot and a count of its tools.

30. Open Cursor's chat — **Cmd+L** on a Mac, **Ctrl+L** on Windows.

    **Check:** a chat panel opens beside the editor.

31. Type: *"What issues are open in Forge right now?"*

    **Check:** your question shows where you type, and it has not been sent yet.

32. Press Enter to send it.

    **Check:** Cursor asks your permission to run a tool from `forge`.

33. Allow it.

    **Check:** Cursor answers with issues from your project.

34. Delete the note. The token now lives in Cursor's settings file, and you will not
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

## If the file already lists other servers

Add only the `"forge": { … }` part of the block from your note, as the first
server in the list.

1. Click straight after `"mcpServers": {` in the file.

   **Check:** the cursor blinks right after the `{`.

2. Press Enter.

   **Check:** the cursor is on a new, empty line.

3. Paste the `"forge": { … }` part of the block from your note.

   **Check:** the new line holds `"forge": {` and the lines that belong to it,
   ending with a `}`.

4. Type a comma straight after that closing `}`.

   **Check:** a comma sits between the end of the `"forge"` part and the name of
   the next server.

## What happens next

Ask in your own words — [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples. Because the settings are in your home folder, the
connection works in every folder you open in Cursor. It lasts until you remove
the `forge` block from `mcp.json` or revoke the token on Forge's **API Tokens**
tab.

If step 28 shows no **forge**, or step 29 shows a red dot, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work).
