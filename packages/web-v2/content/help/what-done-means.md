---
title: Tell when an issue is done
section: Guides
order: 6
---

# Tell when an issue is done

An issue is done when its status reads **Closed**. Forge refuses to close an issue
unless the work shipped, so Closed means the change was released — not only written.

This page answers the three questions that come next: what changed, how to see it
for yourself, and what to do if it is not what you meant.

## Not done yet, however finished it looks

| Status | What it means |
|---|---|
| **Developed**, **Testing** | The change is built and is still being checked. |
| **Awaiting release** | Built and checked, and not yet released. The issue page says when it will be: *"The next release cut runs …"*, or *"No release is scheduled, so this ships when a person cuts one"*. People who can release see a **Release now** button there. |
| **Reopened** | Someone said it was not right. It is back with a person. |
| **Dropped** | Decided against. Nothing was built, and nothing will be. |

Every status, and who holds the issue at each one: [Read an issue's status](?path=issue-statuses).

## What changed

Open the issue. Near the top of its page, a card says in a sentence or two what
you will now see:

- **What changed** — on a closed issue.
- **What will change once it ships** — on one that is built and not yet released.
- **Release note** — on an issue at any other status, such as one reopened after
  it shipped.

If the card says nothing you would see changed, the work had no visible part — a
fix to speed or reliability, say — and there is nothing new to look for.

The panel on the right shows **Merged** with the date the change went in. The
**Comments** tab holds the rest: what was done, and how it was checked.

An issue with no such card has no release note. Read its comments instead.

## See it for yourself

1. Read the **What changed** card, and go to the place it names.
2. Do what your issue described. The steps you wrote to show the problem are the
   check that it is gone.
3. If you still see the old behaviour, reload the page — an open tab can keep
   showing what was there before the release.

## If it is not what you meant

- **It is broken, or it does not do what the issue asked.** Choose **Reopen** at
  the top of the issue page and say what is still wrong. What you write is posted
  as a comment, where whoever picks the work back up reads it.
  A reopened issue is back in a person's hands — see
  [Read an issue's status](?path=issue-statuses) for what moves it on.
- **It works, and you meant something different.** File a new issue that
  describes the difference, and name the first one in it. See
  [Ask for a change](?path=file-a-request).

## Verify it worked

- Your issue reads **Closed**.
- Its page shows the **What changed** card, or its comments say what was done.
- You have seen the change in the place the card names.

## Troubleshooting

| Symptom | What is going on |
|---|---|
| It looks finished and you cannot see the change | Check the status. At **Awaiting release** it has not been released yet — the issue page says when it will be. |
| It is closed and has no **What changed** card | No release note was written for it. The comments say what was done. |
| The card says nothing you would see changed | The work had no visible part. Nothing new should appear. |
