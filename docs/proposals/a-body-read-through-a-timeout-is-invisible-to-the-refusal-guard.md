# The guard that makes every refusal say its body counts one spelling of reading one

Found while merging `main` into ISS-1206's branch, which owns the provision pull's refusal line and
not the guard. Left here rather than fixed, because closing the blind spot makes the guard refuse
ISS-1206's own site, and which of two specs the provision body answers to is a decision nobody has
taken.

## What is measured

`transport/status.rs:every_module_that_reads_a_refusals_body_says_it_through_the_helper` asserts,
per module, that the number of `status::refused` or `status::refusal` calls is at least the number
of response bodies the module reads. It counts a body read by matching the literal `.text().await`
in the module's shipped half.

`transport/provision.rs:pull_pending` reads its refusal's body as

```rust
match tokio::time::timeout(BODY_DEADLINE, resp.text()).await { … }
```

so the two tokens are separated by `)` and the literal never appears. The module reads two bodies
and the guard sees one. Measured at `6acbff75b`: `provision.rs` passes that assertion with
`bodies = 1`, `said = 1`, while `pull_pending` says its body through `provision.rs:body_excerpt`
and not through either helper.

The sibling guard, `no_transport_module_formats_a_status_or_a_body_into_its_own_message`, is blind
to the same site for the same reason: `status_and_body_bindings` admits a `let` whose value holds
`.text().await`, so `let body = match tokio::time::timeout(…, resp.text()).await` binds nothing it
will later check.

## Why it is not a wider pattern in the matcher

Because the site it would then see is one the two specs disagree about, and widening the matcher
decides that disagreement by accident:

- ISS-1234 gave `status.rs:body_line` the rule that a gateway's HTML error page is *named* — its
  title, or its size — and never pasted, with everything else collapsed and cut at 200 characters.
- ISS-1206's criteria 3 to 6 give `provision.rs:body_excerpt` a different rule: collapsed, cut at
  400 Unicode scalar values with the pre-cut length declared, and the literal `<none>` for an empty
  body. Its tests prove each of those.

A matcher that counted `.text()` would put `provision.rs` at two bodies and one helper call and go
red, and the cheapest way to green would be to drop `body_excerpt` — which silently retires four
criteria a judge has not yet ruled on.

## What the mechanism is, not the symptom

Two deliverables, in this order.

1. **One rule for a refusal body, stated once.** Either `body_line` grows the cap, the length
   declaration and the `<none>` that `body_excerpt` carries, or `body_excerpt` is retired and
   ISS-1206's criteria are corrected in the open to `body_line`'s shape. Either way one function
   answers for what a refused call prints, which is what ISS-1233 was arguing for.
2. **A guard that reads the value rather than a spelling.** The status half already does this —
   ISS-1233's second pass rewrote it to measure what a `format!` says after the helpers' own calls
   are cut out, precisely because matching `{status}` by name walked past a rename. The body half is
   still matching a spelling, and `tokio::time::timeout(…, resp.text()).await` is the first spelling
   that walked past it. Any wrapper does: `resp.bytes()`, a helper that reads the body, a `let`
   split across lines.

## Honest costs

- **Closing the guard without doing (1) first turns this into a forced choice under a red gate**,
  which is how a criterion gets retired to make a checker green rather than because anyone decided
  it should be.
- **Leaving it costs what the guard was built to stop, at one site.** A `520` from the edge answers
  with a whole HTML page; `provision.rs` pastes its first 400 Unicode scalar values into the
  journal, with an ellipsis and the page's full collapsed length after them, every time a refusal's
  condition changes — which is exactly the paste ISS-1234 was filed over. It is
  bounded — the ISS-1206 streak writes that line once per condition rather than every ninety
  seconds — so it is a legibility cost and not a disk one.
- **The blind spot is not confined to this site.** Nothing stops the next transport module reading a
  body through a wrapper and printing it by hand; both guards would stay green, and the directory
  would be measured as whole when it is not.
