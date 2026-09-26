---
title: Connect Claude Desktop
section: Connect an assistant
order: 20
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

1. In your web browser, go to `https://nodejs.org` and download the installer
   marked **LTS**.

   **Check:** the installer file is in your **Downloads** folder.

2. Open the installer and follow it through, keeping every choice as it is.

   **Check:** the installer's last screen says the installation is complete.

3. In Forge, select your initials at the bottom of the left-hand menu, then choose
   **Account & Settings**.

   **Check:** the Settings page opens, with tabs along the top that include
   **API Tokens** and **MCP**.

4. Choose the **API Tokens** tab.

   **Check:** a form titled **Create a token** is at the top.

5. In **Name**, type `Claude Desktop`.

   **Check:** the name shows in the box.

6. Under **Scopes**, tick both **read** and **write**. Read lets the assistant
   look things up; write lets it file issues and add comments for you.

   **Check:** both boxes are ticked.

7. In **Bind to a project**, choose the project you want to ask about. The token
   then works for that project only.

   **Check:** the box shows the project's name.

8. Choose **Create token**. If Forge asks for your password, type it and choose
   **Confirm & create**. If it offers **Continue with** your sign-in provider
   instead, choose that, sign in, and choose **Create token** again once you are
   back on this page.

   **Check:** a panel titled **Token created** shows a long code that starts with
   `forge_pat_`.

9. Choose **Copy to clipboard**, and paste the code into your note. Forge shows it
   only this once.

   **Check:** your note holds the whole code, starting with `forge_pat_`.

10. Choose **Done** to close the panel.

    **Check:** your new token is listed under **Your tokens**.

11. Choose the **MCP** tab.

    **Check:** a card titled **Connect a client** shows an **Endpoint** and a
    **Project**.

12. Make sure **Project** shows the project you chose in step 7, and choose it if
    it does not.

    **Check:** under **Config snippet**, a sentence reads *"This snippet
    configures"*, then your project's name, then a short grey label such as
    `my-project` — the project's short name.

13. Copy the address shown under **Endpoint** into your note.

    **Check:** your note holds an address that starts with `https://` and ends
    with `/mcp`.

14. Copy the project's short name from the grey label into your note.

    **Check:** your note holds the token, the address and the short name.

15. Open Claude Desktop's settings. On a Mac, choose **Claude** in the menu bar at
    the top of the screen, then **Settings…**. On Windows, choose the **☰** menu
    at the top left of the Claude window, then **File**, then **Settings…**.

    **Check:** the Settings window opens.

16. Choose **Developer** in the list on the left. If there is no **Developer**,
    follow **If Settings has no Developer** at the end of this page, then come
    back to this step.

    **Check:** the Developer page shows an **Edit Config** button.

17. Choose **Edit Config**. If no window opens, find the folder yourself. On a
    Mac, in Finder choose **Go** › **Go to Folder…**, paste
    `~/Library/Application Support/Claude/` and press Enter. On Windows, paste
    `%APPDATA%\Claude\` into File Explorer's address bar and press Enter.

    **Check:** a Finder window (Mac) or File Explorer window (Windows) shows a
    file called `claude_desktop_config.json`.

18. Open the file in a plain text editor. On a Mac, right-click it and choose
    **Open With** › **TextEdit**. On Windows, right-click it and choose
    **Open with** › **Notepad**.

    **Check:** a window shows the file's text: nothing at all, just `{}`, or some
    text that is already there.

19. If the window is empty or holds only `{}`, select everything in it and paste
    the block below in its place. If it holds anything else, follow **If the file
    already has text in it** at the end of this page instead, then go on to
    step 20.

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

    **Check:** the file starts with `{`, the next line is `"mcpServers": {`, and
    the word `forge` appears on the line after that.

20. Replace `<ENDPOINT>` — angle brackets included — with the address from your
    note. Keep the quote marks around it.

    **Check:** that line reads `"https://…/mcp",` with your address in it.

21. Replace `<YOUR_TOKEN_HERE>` with the token from your note. Leave the word
    `Bearer` and the space after it in place.

    **Check:** that line reads `"AUTH_HEADER": "Bearer forge_pat_…"` with your
    token where the dots are.

22. Replace `<PROJECT>` with the project's short name from your note.

    **Check:** no `<` or `>` is left anywhere in the file.

23. Save the file — **Cmd+S** on a Mac, **Ctrl+S** on Windows.

    **Check:** the window's title no longer marks the file as edited.

24. Quit Claude Desktop completely — closing its window is not enough. On a Mac,
    choose **Claude** › **Quit Claude** in the menu bar. On Windows, right-click
    the Claude icon near the clock at the bottom right of the screen and choose
    **Quit**.

    **Check:** the Claude icon is gone from the Dock (Mac) or from beside the
    clock (Windows).

25. Open Claude Desktop again.

    **Check:** the Claude window opens.

26. Go to **Settings** › **Developer**, the same way as in steps 15 and 16.

    **Check:** **forge** is listed there and marked **running**.

27. Close Settings, start a new chat and ask: *"What issues are open in Forge
    right now?"*

    **Check:** Claude asks your permission to use a tool from `forge`; once you
    allow it, it answers with issues from your project.

28. Delete the note. The token now lives in Claude Desktop's settings file, and
    you will not need the copy again.

    **Check:** the note is gone from your notes app.

## If Settings has no Developer

1. Close the Settings window.

   **Check:** only Claude's chat window is open.

2. Open the **Help** menu — in the menu bar on a Mac, under the **☰** menu on
   Windows — and choose **Troubleshooting** › **Enable Developer Mode**.

   **Check:** the menu closes without an error message.

3. Open Settings again, as in step 15.

   **Check:** **Developer** is now in the list on the left. Go back to step 16.

## If the file already has text in it

Claude Desktop keeps its own preferences in the same file, so add Forge to what
is there rather than replacing it. Each case below pastes this block, the same
connection as in step 19 without the lines around it:

```json
"forge": {
  "command": "npx",
  "args": ["-y", "mcp-remote@0.14.3", "<ENDPOINT>", "--header", "Authorization:${AUTH_HEADER}", "--header", "X-Forge-Project-Slug:${FORGE_PROJECT}"],
  "env": { "AUTH_HEADER": "Bearer <YOUR_TOKEN_HERE>", "FORGE_PROJECT": "<PROJECT>" }
}
```

Do the one step whose description matches your file.

1. **It has `"mcpServers": {` followed by other connections.** Make a new line
   straight after `"mcpServers": {`, paste the block there, and type a comma
   straight after the block's last `}`.

   **Check:** a comma sits between the end of the Forge block and the name of the
   connection after it.

2. **It has `"mcpServers": {}`, with nothing between the braces.** Click between
   the two braces, press Enter, paste the block, and press Enter again. Type no
   comma.

   **Check:** `"mcpServers": {` is followed by `"forge": {`, and the Forge block is
   followed by a `}` on its own.

3. **It has no `"mcpServers"` at all.** Click straight after the very first `{`
   in the file, press Enter, type `"mcpServers": {`, press Enter, paste the block,
   press Enter, and type `},` — a closing brace and a comma.

   **Check:** the file starts `{`, then `"mcpServers": {`, then `"forge": {`, and
   your earlier text follows the `},` you typed.

## What happens next

Ask in your own words — [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples. The connection lasts until you remove the `forge` block
from the file or revoke the token on Forge's **API Tokens** tab.

If step 26 does not show **forge** as running, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work).
