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
    confirm it is you first, a **Confirm password** box with the cursor in it, or a
    **Continue with** button, comes into view instead; or, if a token you made
    before has this name, the words
    **An active token already uses this name.** show under **Name**, with the
    name highlighted.

11. If the **Token created** panel has not appeared, follow
    **If the Token created panel does not appear** at the end of this page. You come
    back to step 12 when the panel is showing.

    **Check:** the panel titled **Token created** shows a long code that starts with
    `forge_pat_`.

12. Choose **Copy to clipboard**. Forge shows the code only this once.

    **Check:** the button changes to **Copied ✓**.

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

17. Drag across the address under **Endpoint**, from `https` to `/mcp`, to
    highlight it.

    **Check:** the whole address is highlighted, from `https://` to `/mcp`.

18. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the address.

    **Check:** the address is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

19. Paste the address into your note.

    **Check:** your note holds an address that starts with `https://` and ends with
    `/mcp`.

20. Drag across the grey short name to highlight it.

    **Check:** the whole short name is highlighted, and nothing outside the grey
    label is.

21. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the short name.

    **Check:** the short name is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

22. Paste the short name into your note.

    **Check:** your note holds the token, the address and the short name.

23. In your app, open the place where it lists connected services. Its label is
    often **MCP**, **MCP servers**, **Connectors**, **Tools** or **Integrations**.

    **Check:** you see a list of connected services, or a button to add one.

24. Choose to add a new connected service.

    **Check:** the app asks which kind to add, asks for a name and an address, or
    asks you to paste a block of settings.

25. If the app asks which kind to add, choose the kind that connects to an address —
    often called **Streamable HTTP**, **HTTP**, **Remote** or **URL**.

    **Check:** if the app has such a kind, it now asks for a name and an address.

26. If your app offers only a kind that starts a program (**Command** or **stdio**),
    follow **If your app only starts programs** at the end of this page. You go on
    to step 43 when you have finished it.

    **Check:** if you followed it, your app shows the settings you gave it, with
    your token in them.

27. If your app asked you to paste a block of settings, follow
    **If your app asks for a block of settings** at the end of this page. You go on
    to step 43 when you have finished it.

    **Check:** if you followed it, your app shows the block, with your token in it.

28. For the name, type `forge`.

    **Check:** the name box shows `forge`.

29. In your note, drag across the address to highlight it.

    **Check:** the whole address is highlighted, from `https://` to `/mcp`.

30. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the address.

    **Check:** the address is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

31. Paste the address into the address box.

    **Check:** the address box shows the address ending in `/mcp`.

32. Choose to add a header. Apps label it **Add header**, **Headers** or a **+**
    beside **Headers**.

    **Check:** the app shows an empty box for the header's name and one for its
    value.

33. In the header's name box, type `Authorization`.

    **Check:** the name box shows `Authorization`.

34. In the header's value box, type `Bearer` followed by one space.

    **Check:** the value box shows `Bearer`, with the cursor one space after it.

35. In your note, drag across the code to highlight it.

    **Check:** the whole code is highlighted, from `forge_pat_` to its last character.

36. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the code.

    **Check:** the code is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

37. Paste the code into the value box, after the space.

    **Check:** the value reads `Bearer forge_pat_…`, with your token where the dots
    are.

38. Choose to add a second header.

    **Check:** a second pair of empty boxes appears, for a name and a value.

39. In the new header's name box, type `X-Forge-Project-Slug`.

    **Check:** the name box shows `X-Forge-Project-Slug`.

40. In your note, drag across the short name to highlight it.

    **Check:** the whole short name is highlighted.

41. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the short name.

    **Check:** the short name is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

42. Paste the short name into the new header's value box.

    **Check:** two headers are listed, `Authorization` and `X-Forge-Project-Slug`,
    each with its value.

43. Save.

    **Check:** **forge** is listed, or your app asks you to restart it.

44. If your app asked you to restart it, quit it completely.

    **Check:** if you did, none of your app's windows is open.

45. If you quit your app, open it again.

    **Check:** if you did, your app's window opens.

46. Open the place where your app lists connected services, as in step 23.

    **Check:** **forge** is listed as connected, and your app shows its tools or a
    count of them.

47. Start a new chat.

    **Check:** the new chat is empty and waiting for your question.

48. Type: *"What issues are open in Forge right now?"*

    **Check:** your question shows where you type, and it has not been sent yet.

49. Send the question. Most apps send it when you press Enter.

    **Check:** your app asks permission to use a tool from `forge`, or goes straight
    to an answer.

50. If your app asked permission, allow it.

    **Check:** the answer names issues from your project.

51. Delete the note. The token now lives in your app's settings, and you will not
    need the copy again.

    **Check:** the note is gone from your notes app.

## If the Token created panel does not appear

After step 10 you see one of three things instead of the **Token created** panel:
a **Confirm password** box or a **Continue with** button, when Forge checks that it
is really you before it makes a token, or the words
**An active token already uses this name.** under **Name**. Do the part below
that matches what you see. You finish with the **Token created** panel, and then
you go on to step 12.

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

If you see **An active token already uses this name.** under **Name**:

A token you made before already has this name, for another project or from a
time you lost its code, and this one needs a name of its own. You could revoke
the old token under **Your tokens** instead, but anything still using it would
stop working, so a new name is the safer way on.

1. Type a name none of your tokens has, such as the name of your app with a 2 after it. The old name in
   **Name** is highlighted, so what you type replaces it.

   **Check:** **Name** shows the new name.

2. Choose **Create token**.

   **Check:** a panel titled **Token created** appears; or a **Confirm password**
   box or a **Continue with** button comes into view.

If the **Confirm password** box or the **Continue with** button came into view,
do the part above that matches it.

## If your app only starts programs

Some apps can only connect by starting a program on your computer. For those, use
the same small helper Claude Desktop uses. It needs **Node.js**, which the first
steps below install, and your app gives it these settings:

| Setting | Value |
|---|---|
| Command | `npx` |
| Arguments | seven, which the steps below give one at a time, in order |
| Environment variable `AUTH_HEADER` | `Bearer`, a space, and your token |
| Environment variable `FORGE_PROJECT` | the project's short name |

The helper fills in `${AUTH_HEADER}` and `${FORGE_PROJECT}` from the two
environment variables. After Node.js, the steps below give your app those settings
one at a time.

1. In your web browser, go to `https://nodejs.org`.

   **Check:** the page offers downloads, one of them marked **LTS**.

2. Choose the download marked **LTS**.

   **Check:** the installer file is in your **Downloads** folder.

3. Open the installer.

   **Check:** the installer's first screen opens.

4. On each installer screen, choose the button that moves forward — **Next**,
   **Continue** or **Agree** — and leave every other choice as it is. Stop when the
   forward button reads **Install**, or when a screen will not let you move forward
   until you tick a box that accepts its license.

   **Check:** the forward button reads **Install**; or, on Windows, the screen shows
   the license with a box reading **I accept the terms in the License Agreement**,
   and **Next** is greyed out.

5. If the screen shows a box reading
   **I accept the terms in the License Agreement**, tick it.

   **Check:** if there was one, it is ticked and **Next** is no longer greyed out.

6. If the forward button does not read **Install** yet, go on choosing it on each
   screen until it does.

   **Check:** the forward button reads **Install**.

7. Choose **Install**.

   **Check:** the installer shows a progress bar, or your computer asks for
   permission to install.

8. If your Mac asks for your password to allow the install, type the password you
   sign in to your computer with.

   **Check:** if it asked, the box shows dots, one for each character you typed.

9. If you typed your password, choose **Install Software**.

   **Check:** if you did, the password box closes and the installer shows its
   progress bar.

10. If Windows asks whether to let the installer make changes, choose **Yes**.

    **Check:** the installer's last screen says the installation is complete.

11. In your app, choose the kind of connection that starts a program — often
    **Command**, **stdio** or **Local**.

    **Check:** the app asks for a name, a command and its arguments.

12. For the name, type `forge`.

    **Check:** the name box shows `forge`.

13. In the command box, type `npx`.

    **Check:** the command box shows `npx`.

14. Type `-y` as the first argument.

    **Check:** the first argument reads exactly `-y`.

15. Start the next argument — with Enter where the app takes one argument per line,
    or with the app's button that adds one.

    **Check:** an empty place for the second argument is ready.

16. Type `mcp-remote@0.14.3` as the second argument.

    **Check:** the second argument reads exactly `mcp-remote@0.14.3`.

17. Start the next argument — with Enter where the app takes one argument per line,
    or with the app's button that adds one.

    **Check:** an empty place for the third argument is ready.

18. In your note, drag across the address to highlight it.

    **Check:** the whole address is highlighted, from `https://` to `/mcp`.

19. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the address.

    **Check:** the address is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

20. Paste the address as the third argument.

    **Check:** the third argument is the address, ending in `/mcp`.

21. Start the next argument — with Enter where the app takes one argument per line,
    or with the app's button that adds one.

    **Check:** an empty place for the fourth argument is ready.

22. Type `--header` as the fourth argument.

    **Check:** the fourth argument reads exactly `--header`.

23. Start the next argument — with Enter where the app takes one argument per line,
    or with the app's button that adds one.

    **Check:** an empty place for the fifth argument is ready.

24. Type `Authorization:${AUTH_HEADER}` as the fifth argument.

    **Check:** the fifth argument reads exactly `Authorization:${AUTH_HEADER}`, with
    no space after the colon.

25. Start the next argument — with Enter where the app takes one argument per line,
    or with the app's button that adds one.

    **Check:** an empty place for the sixth argument is ready.

26. Type `--header` as the sixth argument.

    **Check:** the sixth argument reads exactly `--header`.

27. Start the next argument — with Enter where the app takes one argument per line,
    or with the app's button that adds one.

    **Check:** an empty place for the seventh argument is ready.

28. Type `X-Forge-Project-Slug:${FORGE_PROJECT}` as the seventh argument.

    **Check:** seven arguments are listed, in this order: `-y`, `mcp-remote@0.14.3`,
    your address, `--header`, `Authorization:${AUTH_HEADER}`, `--header`,
    `X-Forge-Project-Slug:${FORGE_PROJECT}`.

29. Add an environment variable. Apps label it **Env**, **Environment** or a **+**
    beside one of those.

    **Check:** the app shows an empty box for the variable's name and one for its
    value.

30. In the variable's name box, type `AUTH_HEADER`.

    **Check:** the name box shows `AUTH_HEADER`.

31. In the variable's value box, type `Bearer` followed by one space.

    **Check:** the value box shows `Bearer`, with the cursor one space after it.

32. In your note, drag across the code to highlight it.

    **Check:** the whole code is highlighted, from `forge_pat_` to its last
    character.

33. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the code.

    **Check:** the code is still highlighted. A copy changes nothing on the screen;
    the next paste shows it worked.

34. Paste the code into the value box, after the space.

    **Check:** the value reads `Bearer forge_pat_…`, with your token where the dots
    are.

35. Add a second environment variable.

    **Check:** a second pair of empty boxes appears, for a name and a value.

36. In the new variable's name box, type `FORGE_PROJECT`.

    **Check:** the name box shows `FORGE_PROJECT`.

37. In your note, drag across the short name to highlight it.

    **Check:** the whole short name is highlighted.

38. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the short name.

    **Check:** the short name is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

39. Paste the short name into the new variable's value box.

    **Check:** two variables are listed, `AUTH_HEADER` and `FORGE_PROJECT`, each
    with its value.

Now go on to step 43.

## If your app asks for a block of settings

1. In Forge, choose the **Generic** tab above the snippet on the **MCP** tab.

   **Check:** the snippet is a block of settings that names the connection `"forge"`
   and holds `<YOUR_TOKEN_HERE>`.

2. Choose **Copy**.

   **Check:** the button changes to **Copied ✓**.

3. Paste the block into your app's box for it.

   **Check:** the box shows the block.

4. In your note, drag across the code, from `forge_pat_` to its last character, to
   highlight it.

   **Check:** the whole code is highlighted, and nothing else in the note is.

5. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the code.

   **Check:** the code is still highlighted. A copy changes nothing on the screen;
   the next paste shows it worked.

6. In your app's box, drag across `<YOUR_TOKEN_HERE>`, from `<` to `>`, to
   highlight it.

   **Check:** `<YOUR_TOKEN_HERE>` is highlighted with both angle brackets, and the
   word `Bearer` and the space before it are not.

7. Press **Cmd+V** on a Mac, or **Ctrl+V** on Windows, to paste the code over it.

   **Check:** the block reads `"Authorization": "Bearer forge_pat_…"`, with your
   code where the dots are, and no `<` or `>` is left in the block.

## If something goes wrong

See [When it does not work](?path=connect-an-assistant/when-it-does-not-work).
Many apps show the reason next to the service's name in their list.
