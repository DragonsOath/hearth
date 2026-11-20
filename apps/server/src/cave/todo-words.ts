/**
 * What the owner asked about the to-do list in this message, read on the
 * server from their own words. These are the only grants Ember gets
 * to change the list: it can always suggest, but it saves, defers, closes,
 * or dismisses an item only when this message asked for it. None of them
 * permits doing the work itself.
 */
export type TodoCommand = "save" | "defer" | "done" | "dismiss" | "work" | "show" | "edit";

const IT = String.raw`(?:it|that|this|those|them|both|these|all (?:of )?(?:them|those)|the (?:\w+ ){0,3}(?:one|ones|issue|problem|idea|thing|item)s?|#?\d+)`;

const SAVE = new RegExp(
  String.raw`\b(?:(?:add|put|save|stick|throw|write|pop|log|note)(?: ${IT})?(?: down)? (?:on|to|in|onto) (?:the|our|my|your) (?:to-?do|todo|list|backlog|issues? list)|add ${IT} to (?:the )?list|remind me(?: about)?|save ${IT} for later|keep (?:an eye on |track of )?${IT}(?: on the list)?|make ${IT} (?:a|an) (?:task|to-?do|item|issue|idea)|track ${IT}|don'?t let me forget|let'?s not forget|(?:add|save) ${IT}\b(?! to (?:the )?(?:vault|memory)))`,
  "i",
);
const DEFER = new RegExp(
  String.raw`\b(?:back ?burner|put ${IT} off|(?:park|shelve) ${IT}|(?:for|until) later|later on|deal with ${IT} later|not now(?:,)? but|some ?day|remind me (?:about ${IT} )?later|we put off)\b`,
  "i",
);
const DONE = new RegExp(
  String.raw`\b(?:mark (?:${IT}|.{0,40}?) (?:as )?(?:done|resolved|fixed|complete|completed|finished)|(?:it'?s|that'?s|this is|those are|they'?re) (?:all )?(?:fixed|done|resolved|sorted)|close ${IT}(?: out)?|check ${IT} off|cross ${IT} off|${IT} (?:is|are) (?:fixed|done|resolved) now)\b`,
  "i",
);
const DISMISS = new RegExp(
  String.raw`\b(?:(?:we|you) can (?:ignore|skip|drop) ${IT}|ignore ${IT}|never ?mind|forget (?:about )?${IT}|dismiss ${IT}|not worth (?:it|tracking|worrying)|drop ${IT}|don'?t (?:bother|worry) (?:about|with) ${IT}|take ${IT} off (?:the )?list|remove ${IT} from (?:the )?list)\b`,
  "i",
);
const WORK = new RegExp(
  String.raw`\b(?:let'?s (?:work on|tackle|look (?:at|into)|dig into|fix|handle|start (?:on|with)|do) ${IT}(?: now)?|work on ${IT}(?: now)?|(?:pick|take) ${IT} up|resume ${IT})\b`,
  "i",
);
const SHOW =
  /\b(?:what'?s on (?:our|the|my) (?:to-?do )?list|(?:show|open|read|check) (?:me )?(?:our|the|my) (?:to-?do |todo )?list|what (?:should|could|can) we (?:tackle|work on|do|fix|start)(?: today| next| now)?|what did we (?:put off|defer|park|save|shelve)|(?:show|list|tell) (?:me )?(?:the |all |our |my )?(?:open|unresolved|outstanding|pending|deferred|saved)|what'?s (?:still )?(?:open|outstanding|left)|anything (?:on|left on) (?:the|our) list)\b/i;
const EDIT =
  /\b(?:(?:make|set|bump|raise|lower|drop) (?:it|that|this|#?\d+|the \w+ one)(?:'?s)? (?:to |priority to )?(?:high|medium|low|urgent)(?: priority)?|(?:higher|lower) priority|rename (?:it|that)|(?:it|that) belongs (?:to|in)|move (?:it|that) to (?:the )?\w+ project)\b/i;

export function todoCommands(text: string): Set<TodoCommand> {
  const out = new Set<TodoCommand>();
  if (SAVE.test(text)) out.add("save");
  if (DEFER.test(text)) out.add("defer");
  if (DONE.test(text)) out.add("done");
  if (DISMISS.test(text)) out.add("dismiss");
  if (WORK.test(text)) out.add("work");
  if (SHOW.test(text)) out.add("show");
  if (EDIT.test(text)) out.add("edit");
  // Deferring something keeps it: it is a kind of saving.
  if (out.has("defer") && /\b(remind|back ?burner|park|shelve|later)\b/i.test(text))
    out.add("save");
  return out;
}

/** What the owner asked, for the system prompt. */
export function todoModeText(commands: Set<TodoCommand>): string {
  const lines: string[] = [];
  if (commands.has("save") || commands.has("defer"))
    lines.push(
      commands.has("defer")
        ? "The owner asked to keep it for later: save it now as deferred (save_todo with deferred), without asking again. Then confirm in one short line with its number."
        : "The owner asked to put it on the list: save it now (save_todo), without asking again. Then confirm in one short line with its number.",
    );
  if (commands.has("done"))
    lines.push(
      "The owner says it is done: mark the item they mean resolved (update_todo). If you can check it live, say what you saw.",
    );
  if (commands.has("dismiss"))
    lines.push(
      "The owner wants it dropped: dismiss the item or suggestion they mean (update_todo, dismissed), and do not raise it again.",
    );
  if (commands.has("work"))
    lines.push(
      "The owner wants to work on an item now: find it (the numbers below, or todo_list), check its current state, set it investigating, and pick up from its history and linked plans rather than starting over. Working on it still needs the usual approval for any change.",
    );
  if (commands.has("show"))
    lines.push(
      "The owner is asking about the list: answer from it (todo_list for anything not shown below). For issues, say which look still active, which look resolved, and which are unverified.",
    );
  return lines.join("\n");
}
