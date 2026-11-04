**Each core start reports to Sentry.** When a Sentry DSN is set, core sends one info event, "core started <version>", as it begins serving, so every deploy shows its error reports reach the tracker.
