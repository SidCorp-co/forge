---
title: Connect Claude Code
section: Connect an assistant
order: 30
---

# Connect Claude Code

Claude Code is Claude in a terminal window. This page connects it to one of your
Forge projects: you create a token in Forge, copy one line Forge writes for you,
and run it in a terminal.

## Before you start

- Claude Code is installed and you have signed in to it at least once. To check,
  open a terminal (step 15 below says how) and type `claude --version`, then
  press Enter: it prints a version number.
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

3. In **Name**, type `Claude Code`.

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

   **Check:** you are back on the **API Tokens** tab, and your new token is listed
   under **Your tokens**.

9. Choose the **MCP** tab.

   **Check:** a card titled **Connect a client** shows an **Endpoint** and a
   **Project**.

10. Make sure **Project** shows the project you chose in step 5, and choose it if
    it does not.

    **Check:** under **Config snippet**, a sentence reads *"This snippet
    configures"* followed by your project's name.

11. Choose the **Claude CLI** tab above the snippet.

    **Check:** the snippet is one line starting `claude mcp add`, and the words
    above it say to run it in a terminal.

12. Choose **Copy**.

    **Check:** the button changes to **Copied ✓**.

13. Paste the line into your note, under the code.

    **Check:** your note holds the code and, below it, the line starting
    `claude mcp add`.

14. In the line, replace `<YOUR_TOKEN_HERE>` — angle brackets included — with the
    code from step 7. Leave the word `Bearer` and the space after it in place.

    **Check:** the part in quotes reads `"Authorization: Bearer forge_pat_…"`, with
    your code where the dots are, and no `<` or `>` is left anywhere in the line.

15. Open a terminal. On a Mac, press **Cmd+Space**, type `Terminal` and press
    Enter. On Windows, open the **Start** menu, type `PowerShell` and press Enter.

    **Check:** a window opens with a line waiting for you to type.

16. Copy the whole line from your note, paste it into the terminal and press
    Enter.

    **Check:** the terminal prints `Added HTTP MCP server forge with URL:` followed
    by the Endpoint from step 9 and `to user config`.

17. Type `claude mcp list` and press Enter.

    **Check:** a line starts with `forge:` and ends with `✔ Connected`.

18. Type `claude` and press Enter.

    **Check:** Claude Code starts and waits for your question.

19. Ask: *"What issues are open in Forge right now?"*

    **Check:** Claude Code asks your permission to use a tool from `forge`; once
    you allow it, it answers with issues from your project.

20. Delete the note. The token now lives in Claude Code's own settings, and you
    will not need the copy again.

    **Check:** the note is gone from your notes app.

## What happens next

Ask in your own words — [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples. The connection works from any folder you start Claude Code
in, and it lasts until you remove it with `claude mcp remove forge -s user` or
revoke the token on the **API Tokens** tab.

If step 17 shows `✘ Failed to connect`, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work) — the
words after it say which of the five problems it is.
