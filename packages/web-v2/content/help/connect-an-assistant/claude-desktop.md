---
title: Connect Claude Desktop
section: Connect an assistant
order: 20
audience: assistant-setup
---

# Connect Claude Desktop

Claude Desktop is the Claude app for Mac and Windows. This page connects it to
one of your Forge projects.

It takes one more piece than the other apps. Claude Desktop's own screen for
adding a connection only accepts services you sign in to through a web page,
and Forge uses a token instead. So Claude Desktop starts a small free helper
program that carries your token to Forge, and that helper needs **Node.js**
installed. The steps below install it.

## Before you start

- Claude Desktop is installed on your Mac or Windows computer and you are signed
  in.
- You can install software on this computer.
- You can open the Forge project you want to ask about.
- Open a blank note to paste into as you go — **Notes** or **TextEdit** on a
  Mac, **Notepad** on Windows. You will delete it at the end.

## Steps

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
   screen, as in step 4, until it does.

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

11. In Forge, select your initials at the bottom of the left-hand menu.

    **Check:** a short menu opens, with **Account & Settings** in it.

12. Choose **Account & Settings**.

    **Check:** the Settings page opens, with tabs along the top that include
    **API Tokens** and **MCP**.

13. Choose the **API Tokens** tab.

    **Check:** a list titled **Your tokens** is at the top of the tab.

14. Scroll down, below **Your tokens**, to the form titled **Create a token**.

    **Check:** the form's first box, **Name**, is in view.

15. In **Name**, type `Claude Desktop`.

    **Check:** the name shows in the box.

16. Under **Scopes**, tick **write**; **read** is already ticked for you. Read lets
    the assistant look things up; write lets it make changes for you, such as filing
    an issue or adding a comment.

    **Check:** both **read** and **write** are ticked.

17. Under **Permissions**, choose **Only the permissions I pick**.

    **Check:** a list of permissions, each with a box, appears under that choice,
    and none of them is ticked.

18. Tick `issues:read`. The form needs at least one permission, and these
    permissions limit a different way into Forge from the one your assistant uses,
    so the smallest one is enough. What your assistant may do is set by **Scopes**
    and by **Bind to a project**.

    **Check:** `issues:read` is the only permission ticked.

19. In **Bind to a project**, choose the project you want to ask about. The token
    then works for that project only.

    **Check:** the box shows the project's name.

20. Choose **Create token**.

    **Check:** a panel titled **Token created** appears; or, if Forge wants to
    confirm it is you first, a **Confirm password** box with the cursor in it, or a
    **Continue with** button, comes into view instead.

21. If the **Token created** panel has not appeared, follow
    **If Forge asks you to confirm it is you** at the end of this page. You come
    back to step 22 when the panel is showing.

    **Check:** the panel titled **Token created** shows a long code that starts with
    `forge_pat_`.

22. Choose **Copy to clipboard**. Forge shows the code only this once.

    **Check:** the button changes to **Copied ✓**.

23. Paste the code into your note.

    **Check:** your note holds the whole code, starting with `forge_pat_`.

24. Choose **Done** to close the panel.

    **Check:** you are back on the **API Tokens** tab, and your new token is listed
    under **Your tokens**.

25. Choose the **MCP** tab.

    **Check:** a card titled **Connect a client** shows an **Endpoint** and a
    **Project**.

26. In **Project**, choose the project you chose in step 19. It may already be
    showing.

    **Check:** under **Config snippet**, a sentence reads
    *"This snippet configures"*, then your project's name, then a short grey label
    such as `my-project` — the project's short name.

27. Drag across the address shown under **Endpoint**, from `https` to `/mcp`, to
    highlight it.

    **Check:** the whole address is highlighted, from `https://` to `/mcp`.

28. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the address.

    **Check:** the address is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

29. Paste the address into your note.

    **Check:** your note holds an address that starts with `https://` and ends with
    `/mcp`.

30. Drag across the project's short name in the grey label to highlight it.

    **Check:** the whole short name is highlighted, and nothing outside the grey
    label is.

31. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the short name.

    **Check:** the short name is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

32. Paste the short name into your note.

    **Check:** your note holds the token, the address and the short name.

33. Open Claude Desktop's settings. On a Mac, choose **Claude** › **Settings…** in
    the menu bar at the top of the screen. On Windows, choose **☰** › **File** ›
    **Settings…**; the **☰** menu is at the top left of the Claude window.

    **Check:** the Settings window opens.

34. Choose **Developer** in the list on the left.

    **Check:** the Developer page shows an **Edit Config** button; or the list has
    no **Developer**.

35. If the list has no **Developer**, follow **If Settings has no Developer** at the
    end of this page. You come back to step 34 when **Developer** is in the list.

    **Check:** the Developer page shows an **Edit Config** button.

36. Choose **Edit Config**.

    **Check:** a Finder window (Mac) or File Explorer window (Windows) shows a file
    called `claude_desktop_config.json`; or no window opens.

37. If no window opened, follow **If Edit Config opens no window** at the end of
    this page. You come back to step 38 when the window shows the file.

    **Check:** a Finder window (Mac) or File Explorer window (Windows) shows a file
    called `claude_desktop_config.json`.

38. Open the file in a plain text editor. On a Mac, choose **Open With** ›
    **TextEdit** from the file's right-click menu. On Windows, choose **Open with**
    › **Notepad** from the file's right-click menu.

    **Check:** a window shows the file's text: nothing at all, just `{}`, or some
    text that is already there.

39. If the window is empty or holds only `{}`, choose **Copy** above the block
    below, here on this page.

    ```json
    {
      "mcpServers": {
        "forge": {
          "command": "npx",
          "args": [
            "-y",
            "mcp-remote@0.14.3",
            "<ENDPOINT>",
            "--header",
            "Authorization:${AUTH_HEADER}",
            "--header",
            "X-Forge-Project-Slug:${FORGE_PROJECT}"
          ],
          "env": {
            "AUTH_HEADER": "Bearer <YOUR_TOKEN_HERE>",
            "FORGE_PROJECT": "<PROJECT>"
          }
        }
      }
    }
    ```

    **Check:** if you did, the button changes to **Copied ✓** for a moment.

40. If the window holds only `{}`, select everything in it — **Cmd+A** on a Mac,
    **Ctrl+A** on Windows.

    **Check:** if you did, the `{}` is highlighted.

41. If you copied the block in step 39, paste it into the file's window — **Cmd+V**
    on a Mac, **Ctrl+V** on Windows.

    **Check:** if you did, the file starts with `{`, the next line is
    `"mcpServers": {`, and the word `forge` appears on the line after that.

42. If the window held any other text when you opened the file in step 38, follow
    **If the file already has text in it** at the end of this page. You go on to
    step 43 when you have finished it.

    **Check:** the file has `"forge": {` in it.

43. In your note, drag across the address, from `https` to `/mcp`, to highlight it.

    **Check:** the whole address is highlighted, from `https://` to `/mcp`.

44. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the address.

    **Check:** the address is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

45. In the file, drag across `<ENDPOINT>`, from `<` to `>`, to highlight it.

    **Check:** `<ENDPOINT>` is highlighted with both angle brackets, and the quote
    marks around it are not.

46. Press **Cmd+V** on a Mac, or **Ctrl+V** on Windows, to paste the address over it.

    **Check:** where `<ENDPOINT>` was, the file reads `"https://…/mcp"`, with your
    address in the quote marks.

47. In your note, drag across the code, from `forge_pat_` to its last character, to
    highlight it.

    **Check:** the whole code is highlighted, and nothing else in the note is.

48. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the code.

    **Check:** the code is still highlighted. A copy changes nothing on the screen;
    the next paste shows it worked.

49. In the file, drag across `<YOUR_TOKEN_HERE>`, from `<` to `>`, to highlight it.

    **Check:** `<YOUR_TOKEN_HERE>` is highlighted with both angle brackets, and the
    word `Bearer` and the space before it are not.

50. Press **Cmd+V** on a Mac, or **Ctrl+V** on Windows, to paste the code over it.

    **Check:** the file reads `"AUTH_HEADER": "Bearer forge_pat_…"`, with your code
    where the dots are.

51. In your note, drag across the short name to highlight it.

    **Check:** the whole short name is highlighted, and nothing else in the note is.

52. Press **Cmd+C** on a Mac, or **Ctrl+C** on Windows, to copy the short name.

    **Check:** the short name is still highlighted. A copy changes nothing on the
    screen; the next paste shows it worked.

53. In the file, drag across `<PROJECT>`, from `<` to `>`, to highlight it.

    **Check:** `<PROJECT>` is highlighted with both angle brackets, and the quote
    marks around it are not.

54. Press **Cmd+V** on a Mac, or **Ctrl+V** on Windows, to paste the short name over
    it.

    **Check:** the file reads `"FORGE_PROJECT": "…"` with your short name in the
    quote marks, and no `<` or `>` is left anywhere in the file.

55. Save the file — **Cmd+S** on a Mac, **Ctrl+S** on Windows.

    **Check:** the window's title no longer marks the file as edited.

56. Quit Claude Desktop completely — closing its window is not enough. On a Mac,
    choose **Claude** › **Quit Claude** in the menu bar. On Windows, choose **Quit**
    from the right-click menu of the Claude icon near the clock at the bottom right
    of the screen.

    **Check:** the Claude icon is gone from the Dock (Mac) or from beside the clock
    (Windows).

57. Open Claude Desktop again.

    **Check:** the Claude window opens.

58. Open Claude Desktop's settings again, the same way as in step 33.

    **Check:** the Settings window opens.

59. Choose **Developer** in the list on the left.

    **Check:** **forge** is listed there and marked **running**.

60. Close Settings.

    **Check:** only Claude's chat window is open.

61. Start a new chat.

    **Check:** the new chat is empty and waiting for your question.

62. Type: *"What issues are open in Forge right now?"*

    **Check:** your question shows where you type, and it has not been sent yet.

63. Press Enter to send it.

    **Check:** Claude asks your permission to use a tool from `forge`.

64. Allow it.

    **Check:** Claude answers with issues from your project.

65. Delete the note. The token now lives in Claude Desktop's settings file, and you
    will not need the copy again.

    **Check:** the note is gone from your notes app.

## If Forge asks you to confirm it is you

Forge sometimes checks that it is really you before it makes a token. After
step 20 you see either a **Confirm password** box or a **Continue with** button
instead of the **Token created** panel. Do the part below that matches what you
see. Either way you finish with the **Token created** panel, and then you go on
to step 22.

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

## If Settings has no Developer

1. Close the Settings window.

   **Check:** only Claude's chat window is open.

2. Choose **Help** › **Troubleshooting** › **Enable Developer Mode**. On a Mac the
   **Help** menu is in the menu bar; on Windows it is under the **☰** menu.

   **Check:** the menu closes without an error message.

3. Open Settings again, as in step 33.

   **Check:** **Developer** is now in the list on the left.

Now go back to step 34.

## If Edit Config opens no window

Find the folder yourself. On a Mac, do the first three steps below. On Windows, do
the last four.

1. In Finder, choose **Go** › **Go to Folder…**.

   **Check:** a box asks for a folder.

2. Type `~/Library/Application Support/Claude/` into the box.

   **Check:** the box shows that folder.

3. Press Enter.

   **Check:** a Finder window shows a file called `claude_desktop_config.json`.

4. Open File Explorer.

   **Check:** a File Explorer window opens, with an address bar along the top.

5. Click the address bar.

   **Check:** the text in the address bar is highlighted.

6. Type `%APPDATA%\Claude\` into the address bar.

   **Check:** the address bar shows that folder.

7. Press Enter.

   **Check:** a File Explorer window shows a file called
   `claude_desktop_config.json`.

Now go back to step 38.

## If the file already has text in it

Claude Desktop keeps its own preferences in the same file, so add Forge to what
is there rather than replacing it. Each part below copies and pastes this block,
the same connection as in step 39 without the lines around it:

```json
"forge": {
  "command": "npx",
  "args": ["-y", "mcp-remote@0.14.3", "<ENDPOINT>", "--header", "Authorization:${AUTH_HEADER}", "--header", "X-Forge-Project-Slug:${FORGE_PROJECT}"],
  "env": { "AUTH_HEADER": "Bearer <YOUR_TOKEN_HERE>", "FORGE_PROJECT": "<PROJECT>" }
}
```

Do the one part whose description matches your file.

### It has `"mcpServers": {` followed by other connections

1. Choose **Copy** above the block at the top of this section.

   **Check:** the button changes to **Copied ✓** for a moment.

2. Click straight after `"mcpServers": {`.

   **Check:** the cursor blinks right after the `{`.

3. Press Enter.

   **Check:** the cursor is on a new, empty line.

4. Paste the block you copied.

   **Check:** the new line holds `"forge": {` and the lines that belong to it.

5. Type a comma straight after the block's last `}`.

   **Check:** a comma sits between the end of the Forge block and the name of the
   connection after it.

### It has `"mcpServers": {}`, with nothing between the braces

1. Choose **Copy** above the block at the top of this section.

   **Check:** the button changes to **Copied ✓** for a moment.

2. Click between the two braces.

   **Check:** the cursor blinks between the `{` and the `}`.

3. Press Enter.

   **Check:** the `}` has moved to the line below the `{`.

4. Paste the block you copied, with no comma after it.

   **Check:** `"mcpServers": {` is followed by `"forge": {`.

5. Press Enter.

   **Check:** the `}` after the Forge block is on a line of its own.

### It has no `"mcpServers"` at all

1. Choose **Copy** above the block at the top of this section.

   **Check:** the button changes to **Copied ✓** for a moment.

2. Click straight after the very first `{` in the file.

   **Check:** the cursor blinks right after that `{`.

3. Press Enter.

   **Check:** the cursor is on a new, empty line.

4. Type `"mcpServers": {`.

   **Check:** the new line reads `"mcpServers": {`.

5. Press Enter.

   **Check:** the cursor is on a new, empty line below it.

6. Paste the block you copied.

   **Check:** the line below `"mcpServers": {` holds `"forge": {`.

7. Press Enter.

   **Check:** the cursor is on a new, empty line below the Forge block.

8. Type `},` — a closing brace and a comma.

   **Check:** the file starts `{`, then `"mcpServers": {`, then `"forge": {`, and
   your earlier text follows the `},` you typed.

## What happens next

Ask in your own words — [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples. The connection lasts until you remove the `forge` block
from the file or revoke the token on Forge's **API Tokens** tab.

If step 59 does not show **forge** as running, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work).
