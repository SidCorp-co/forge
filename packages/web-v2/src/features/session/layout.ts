// The thread's two width policies, each in exactly one place (ISS-1083).
//
// Before this module the assistant column's cap lived as the same literal in TWO nested elements —
// `conversations/components/conversation-thread.tsx:AssistantTurn` wrapped `<Conversation>` in
// `max-w-[92%] sm:max-w-[85%]` and `session/components/conversation.tsx:AgentTurn` applied the same
// string to the block column inside it. Nested caps multiply: 0.85 x 0.85 = 0.7225, so a turn got
// 72% of the panel and left the rest blank. Measured on the owner's screenshot, a ~550px panel with
// the cards ending at ~390px.
//
// cm:guard the assistant column's cap is a READABLE MEASURE and carries no breakpoint. `ch` binds
// only where the column is wide enough for the measure to matter and never on a narrow one, which
// is the whole of what was asked for. A `sm:` variant here would be a bug waiting for a wide
// monitor: `sm:` asks the VIEWPORT, and `conversation-dock.tsx` is a resizable column bounded
// 360-900px whose width has nothing to do with the screen's — a 400px dock on a 2560px monitor was
// being handed the wide-screen rule.
export const AGENT_COLUMN = "w-full min-w-0 max-w-[72ch]";

// cm:why the bubble KEEPS a percentage where the column does not: a right-aligned bubble says
// "someone else said this" by not spanning its column, so its cap is a relationship to the column
// rather than a measure of its own text. It is one constant because four sites carried the literal
// — `PromptTurn`'s bubble, `PromptTurn`'s attachment row, `conversation-thread.tsx`'s user branch
// and `Unsent` — and the outbox bubble becomes the stored bubble IN PLACE, so two of those four
// agreeing by coincidence is a width change a person watches happen.
export const USER_BUBBLE = "max-w-[88%]";
