// "Waiting on you" reads only what a turn records by calling `await_reply` (ISS-277), so every door
// whose turns are offered the tool says when to call it in the same words: a door that leaves it to
// the tool's description alone leaves its questions reading Done.
export const AWAIT_REPLY_LINE =
  'When your reply ends by asking the person you are answering something you need answered before you can go on, call the `await_reply` tool in the same turn: that call, never the question mark, is what shows them the conversation is waiting on them.';
