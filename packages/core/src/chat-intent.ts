/**
 * Small readings of what the owner typed in the chat, shared by the page and the server.
 */

/**
 * A clear "stop" (11-13: only a clear stop stops; "where is the show and tell browser" is a
 * question, not a stop). The whole message has to be the stop: a word like "stop" inside a longer
 * question never is.
 */
export function isClearStop(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/g, "")
    .replace(/^(ok(ay)?|please|hey|no)[, ]+/, "")
    .replace(/[, ]+(please|now|thanks|thank you)$/, "")
    .trim();
  return /^(stop( it| that| now| there| everything)?|cancel( it| that)?|never ?mind|halt|abort|quit|that'?s enough|enough)$/.test(
    t,
  );
}

/**
 * Whether the "About:" chip (the panel in focus) really is what this message is about (11-13: an
 * unrelated "About: Home Assistant" stayed attached to every message). It is when the message
 * points at it ("this", "it", "here") or names it; a message about something else, or a how-to
 * about a part of Hearth, leaves it out.
 */
export function focusApplies(text: string, name: string | undefined): boolean {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9']+/g, " ")} `;
  if (/ (this|it|its|it's|here|these|that one|this one|them) /.test(t)) return true;
  if (!name) return false;
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  return words.length > 0 && words.some((w) => t.includes(` ${w} `));
}

/**
 * An everyday how-to question (11-13, the owner: "lean mode for everyday how-to questions"):
 * Ember answers it light, on the same model, and switches to full mode by herself when it turns
 * into real work. Only plain asks ("how do I...", "what is...", "where can I..."), short, with no
 * request to do something in the same message.
 */
export function isEverydayQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 300) return false;
  const asks =
    /^(so |and |ok(ay)?,? |hey,? |quick question:? )?(how (do|can|should|would|does|is|are|to)|what('s| is| are| does| do| was)|whats|where('s| is| are| do| can)|which|when (do|does|should|is)|why (do|does|is|are|would)|is (it|there)|are there|can (i|you explain)|do (i|you) need|explain|tell me (about|how|what))\b/;
  return asks.test(t) && !DOING.test(t);
}

const DOING =
  /\b(please (do|fix|set|add|change|install|update|restart|run|make)|go ahead|can you (fix|set|add|change|install|update|restart|run|make|build|move|delete|remove)|for me\b|fix it|set it up|do it|restart|install|delete|remove|update it)\b/;

/**
 * Whether a message asks Ember to do something (make, change, fix, request), not only to answer
 * (11-14): those keep the agent's full thinking; questions think less so nobody waits.
 */
export function asksToDo(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    DOING.test(t) ||
    /^(please |ok(ay)?,? |hey,? |now |can you |could you |would you )?(make|set( up)?|create|add|delete|remove|fix|install|update|restart|build|move|rename|request|send|post|turn|start|stop|clean|change|put)\b/.test(
      t,
    ) ||
    /\b(request|delete|remove|install|create|build|move|rename|send|post) (it|them|that|this|one)\b/.test(
      t,
    )
  );
}

/** What a light answer says, alone, when the question needs real work (Hearth reruns it in full). */
export const NEEDS_FULL_MODE = "NEEDS_FULL_MODE";

/** Whether a light answer asked to go to full mode. */
export function asksFullMode(text: string | undefined): boolean {
  return Boolean(
    text &&
    text
      .trim()
      .replace(/[`*.\s]+/g, "")
      .startsWith(NEEDS_FULL_MODE),
  );
}
