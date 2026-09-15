---
title: Read an issue's status
section: Reference
order: 10
---

# Read an issue's status

Every issue carries one status. The status answers a single question — **who holds
this work right now** — and from that follows what, if anything, you have to do.

There are only three answers, and the tabs on the Issues list are named after
them: the work is **with an agent**, it **needs you**, or it is **finished**.

## The short version

| Status | Who holds it | What you do |
|---|---|---|
| **Draft** | you | Nothing is running. Open it when you are ready to start it. |
| **Open** | an agent | Nothing. It has been picked up. |
| **In progress** | an agent | Nothing. |
| **Developed**, **Testing** | an agent | Nothing. |
| **Needs info** | **you** | **Answer the question.** The work restarts by itself once you do. |
| **On hold** | **you** | **Resume it.** Nothing moves until you do — this is a brake, not a question. |
| **Awaiting release** | **you** | **Approve the release.** It is finished work waiting at the gate. |
| **Reopened** | **you** | Move it on. Nothing picks a reopened issue up on its own. |
| **Closed** | nobody | Done. |
| **Dropped** | nobody | Decided against. It has no way back — file a new issue instead. |

## How an issue moves

```mermaid
flowchart LR
  draft[Draft]:::you --> open[Open]:::bot
  open --> prog[In progress]:::bot
  prog --> dev[Developed]:::bot
  dev --> test[Testing]:::bot
  test --> gate[Awaiting release]:::you
  gate --> closed[Closed]:::end
  prog -.-> info[Needs info]:::you
  info -.answer.-> prog
  prog -.-> hold[On hold]:::you
  hold -.resume.-> prog
  closed -.-> re[Reopened]:::you
  re --> prog
  open -.-> drop[Dropped]:::end

  classDef you fill:#fdf0d5,stroke:#a9822c,color:#5c4410
  classDef bot fill:#eef3fb,stroke:#5a7fb8,color:#24405f
  classDef end fill:#ececea,stroke:#9b9791,color:#4a4741
```

Amber is yours. Blue is the agent's. Grey is over.

The dotted lines are the ones worth knowing: an issue can stop and wait at almost
any point, and it goes back to where it left rather than starting again.

## The three that catch people out

**Needs info and On hold look alike and behave in opposite ways.**
*Needs info* means somebody is asking you something — answer it and the work picks
itself back up. *On hold* means the work was deliberately stopped; answering
nothing restarts it, because there is no question. You resume it by hand.

An issue also lands on hold **whenever a run is cancelled**. That is on purpose:
it parks somewhere nothing will pick up, so a cancel actually stops the work
instead of a fresh run starting seconds later.

**Awaiting release is not finished.** The work is built and verified and is
waiting for a person to approve shipping it. It sits under *Needs you* on the
Issues list for that reason — counting it as done is how a gate stops being
noticed.

**Reopened does not restart anything by itself.** Reopening an issue puts it back
in your hands, not an agent's. Move it on when you want the work to resume.

## Dropped is final

Closing an issue as *dropped* records that the work is not going to happen. There
is no path back out of it — if the work turns out to be wanted after all, file a
new issue. Dropped issues are kept, and appear alongside closed ones under
**Finished** on the Issues list, marked differently: finishing work and deciding
against it are different outcomes and should not read the same.

## While an agent is working

An issue being worked right now is read-only in the places where an edit would be
lost: whatever you set, the running agent may write over it moments later. The
exception is **Needs info** — that stays editable however busy the issue is,
because answering is the whole point of it.

## Verify it worked

- Open a project's Issues list. Each tab carries a count, and **Needs you** is the
  one that wants your attention.
- Open an issue at *Needs info*: it shows the question and a box to answer it.
- Open an issue at *On hold*: it shows a resume action and no question.

## Troubleshooting

| Symptom | What is going on |
|---|---|
| An issue sits still and asks nothing | It is probably *On hold* — resume it. On-hold issues never restart on their own. |
| You answered a question and nothing happened | Check the status moved off *Needs info*. If it did not, the answer did not land — answer it again from the issue page. |
| An issue looks finished but never shipped | It is at *Awaiting release*, waiting for someone to approve the release. |
| You cannot edit a field | An agent is working the issue. Wait for it to park or finish. |
| A dropped issue needs doing after all | File a new issue. Dropped is terminal by design. |

See also [Configure the pipeline & approvals](?path=configure-the-pipeline).
