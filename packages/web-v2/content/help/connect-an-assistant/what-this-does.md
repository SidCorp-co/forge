---
title: What connecting an assistant does
section: Connect an assistant
order: 10
---

# What connecting an assistant does

If you already use an AI assistant — Claude Desktop, Claude Code, Cursor or
another — you can connect it to Forge. Once it is connected, you ask it about
your project in your own words, in the same chat you already use, and it looks
the answer up in Forge for you.

## What you can do once it is connected

- **Ask what is going on.** "What is open right now?", "Which issues are waiting
  for an answer?", "What is ISS-123 about?"
- **Ask for a change.** "File an issue: the invoice PDF should show the billing
  address." The assistant files it as a new issue in your project.
- **Answer and comment.** "Add a comment to ISS-123 saying the fix works on my
  phone."

The assistant does what you ask with **your** access: it can reach only what
your own account can reach, and what it files or writes is recorded under your
name. You can check
anything it changed on the issue's own page in Forge. [What you can ask](?path=connect-an-assistant/what-you-can-ask)
has twenty examples to start from.

## What you need

- The assistant app, installed and signed in.
- A Forge account with access to the project you want to ask about.
- Permission to install software on your computer, if you use Claude Desktop.

You will create a **token** in Forge — a long code that lets your assistant act
as you — and paste it into the assistant's settings. Treat it like a password:
anyone who has it can do in Forge what you can do.

## The one technical word you will meet

Assistants connect to other services through a standard called **MCP** (Model
Context Protocol). You do not need to know how it works. You will see the word
in two places: on the **MCP** tab in Forge's settings, and in some apps'
settings screens, where the list of connected services is labelled with it.
That is all it means here — "where connected services are listed".

## Pick your app

- [Connect Claude Desktop](?path=connect-an-assistant/claude-desktop) — the
  Claude app for Mac or Windows.
- [Connect Claude Code](?path=connect-an-assistant/claude-code) — Claude in a
  terminal window.
- [Connect Cursor](?path=connect-an-assistant/cursor) — the code editor.
- [Connect another app](?path=connect-an-assistant/other-apps) — for any app not
  listed above.

If something does not work, see
[When it does not work](?path=connect-an-assistant/when-it-does-not-work).
