---
title: Connect Cursor
section: Connect an assistant
order: 40
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

1. In Forge, select your initials at the bottom of the left-hand menu, then choose
   **Account & Settings**.

   **Check:** the Settings page opens, with tabs along the top that include
   **API Tokens** and **MCP**.

2. Choose the **API Tokens** tab.

   **Check:** a form titled **Create a token** is at the top.

3. In **Name**, type `Cursor`.

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
    configures"* followed by your project's name.

11. Choose the **Cursor** tab above the snippet.

    **Check:** the words above the snippet name the file `~/.cursor/mcp.json`.

12. Choose **Copy**.

    **Check:** the button changes to **Copied ✓**.

13. Paste the snippet into your note, under the code.

    **Check:** your note holds the code and, below it, a block that starts with
    `{` and contains `"mcpServers"`.

14. In the block, replace `<YOUR_TOKEN_HERE>` — angle brackets included — with the
    code from step 7. Leave the word `Bearer` and the space after it in place.

    **Check:** the line reads `"Authorization": "Bearer forge_pat_…"` with your
    code where the dots are, and no `<` or `>` is left in the block.

15. Open Cursor's settings. On a Mac, press **Cmd+Shift+J**. On Windows, press
    **Ctrl+Shift+J**.

    **Check:** a page titled **Cursor Settings** opens.

16. Choose the section named **MCP** in the list on the left — in some versions
    it is called **Tools & MCP**.

    **Check:** the page lists connected services, or says there are none yet.

17. Choose the button that adds a new server —
    **Add Custom MCP** or **New MCP Server**, depending on your version.

    **Check:** Cursor opens a file called `mcp.json` in an editor tab. It is
    `~/.cursor/mcp.json`: on a Mac, the `.cursor` folder inside your home folder;
    on Windows, `C:\Users\<your name>\.cursor\mcp.json`.

18. If the file is empty, or holds only `{}` or `"mcpServers": {}` with nothing
    between those last braces, select everything in it and paste the block from
    your note in its place. If it already lists other servers under
    `"mcpServers"`, paste only the `"forge": { … }` part on a new line straight
    after `"mcpServers": {`, and type a comma after that part's closing `}`.

    **Check:** the file holds `"forge"` inside `"mcpServers"`, with your token in
    it.

19. Save the file — **Cmd+S** on a Mac, **Ctrl+S** on Windows.

    **Check:** the editor tab no longer marks the file as changed.

20. Go back to the **Cursor Settings** tab.

    **Check:** **forge** is listed with a green dot and a count of its tools. If a
    switch beside it is off, turn it on.

21. Open Cursor's chat — **Cmd+L** on a Mac, **Ctrl+L** on Windows.

    **Check:** a chat panel opens beside the editor.

22. Ask: *"What issues are open in Forge right now?"*

    **Check:** Cursor asks your permission to run a tool from `forge`; once you
    allow it, it answers with issues from your project.

23. Delete the note. The token now lives in Cursor's settings file, and you will
    not need the copy again.

    **Check:** the note is gone from your notes app.

## What happens next

Ask in your own words — [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples. Because the settings are in your home folder, the
connection works in every folder you open in Cursor. It lasts until you remove
the `forge` block from `mcp.json` or revoke the token on Forge's **API Tokens**
tab.

If step 20 shows a red dot or no **forge**, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work).
