---
title: Connect Claude Code
section: Connect an assistant
order: 30
audience: assistant-setup
---

# Connect Claude Code

Claude Code is Claude in a terminal window. This page connects it to one of your
Forge projects: you create a token in Forge, copy one line Forge writes for you,
and run it in a terminal.

## Before you start

- Claude Code is installed and you have signed in to it at least once. To check,
  open a terminal (steps 21 to 23 below say how) and type `claude --version`, then
  press Enter: it prints a version number.
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

5. In **Name**, type `Claude Code`.

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

17. Choose the **Claude CLI** tab above the snippet.

    **Check:** the snippet is one line starting `claude mcp add`, and the words
    above it say to run it in a terminal.

18. Choose **Copy**.

    **Check:** the button changes to **Copied ✓**.

19. Paste the line into your note, under the code.

    **Check:** your note holds the code and, below it, the line starting
    `claude mcp add`.

20. In the line, replace `<YOUR_TOKEN_HERE>` — angle brackets included — with the
    code from step 13, keeping the word `Bearer` and the space after it.

    **Check:** the part in quotes reads `"Authorization: Bearer forge_pat_…"`, with
    your code where the dots are, and no `<` or `>` is left anywhere in the line.

21. To open a terminal, first open your computer's search. On a Mac, press
    **Cmd+Space**. On Windows, press the **Windows** key.

    **Check:** on a Mac, a search box opens; on Windows, the **Start** menu opens.
    Either one is waiting for you to type.

22. Type `Terminal` on a Mac, or `PowerShell` on Windows.

    **Check:** the top result is **Terminal** on a Mac, or **Windows PowerShell** on
    Windows.

23. Press Enter to open the terminal.

    **Check:** a terminal window opens, with a line waiting for you to type.

24. Copy the whole line from your note, from `claude` to the closing quote.

    **Check:** the whole line is highlighted.

25. Paste the line into the terminal.

    **Check:** the terminal shows the line, with the cursor after it. It has not run
    yet.

26. Press Enter.

    **Check:** the terminal prints `Added HTTP MCP server forge with URL:` followed
    by the Endpoint from step 15 and `to user config`.

27. Type `claude mcp list`.

    **Check:** the terminal shows `claude mcp list` after the prompt. It has not run
    yet.

28. Press Enter.

    **Check:** a line starts with `forge:` and ends with `✔ Connected`.

29. Type `claude`.

    **Check:** the terminal shows `claude` after the prompt. It has not run yet.

30. Press Enter.

    **Check:** Claude Code starts and waits for your question.

31. Type: *"What issues are open in Forge right now?"*

    **Check:** your question shows where you type, and it has not been sent yet.

32. Press Enter to send it.

    **Check:** Claude Code asks your permission to use a tool from `forge`.

33. Allow it.

    **Check:** Claude Code answers with issues from your project.

34. Delete the note. The token now lives in Claude Code's own settings, and you will
    not need the copy again.

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

## What happens next

Ask in your own words — [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples. The connection works from any folder you start Claude Code
in, and it lasts until you remove it with `claude mcp remove forge -s user` or
revoke the token on the **API Tokens** tab.

If step 28 shows `✘ Failed to connect`, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work) — the
words after it say which of the five problems it is.
