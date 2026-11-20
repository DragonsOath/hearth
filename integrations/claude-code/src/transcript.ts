import { readFileSync } from "node:fs";

/**
 * Reads a Claude Code session file (one JSON object per line) into the
 * messages worth keeping: what you typed, what Claude wrote, and which
 * tools it used. Each message is numbered by its line, so the same line
 * always gets the same number and resending never duplicates. Tool
 * results and private reasoning are left out (they can be huge, and tool
 * output is where secrets most often appear).
 */

export interface SessionMessage {
  seq: number;
  role: "you" | "ai" | "tool";
  text: string;
  at?: string;
}

interface Line {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  aiTitle?: string;
  message?: {
    content?: string | { type: string; text?: string; name?: string; input?: unknown }[];
  };
}

const SYSTEM_TEXT = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook)/;

export function readSession(file: string): {
  messages: SessionMessage[];
  title?: string;
  lines: number;
} {
  const raw = readFileSync(file, "utf8").split("\n");
  // The last piece is either empty (the file ends with a newline) or a line
  // still being written; either way it waits for next time.
  const complete = raw.slice(0, -1);
  const messages: SessionMessage[] = [];
  let title: string | undefined;
  complete.forEach((text, i) => {
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      return;
    }
    if (line.type === "ai-title" && line.aiTitle) title = line.aiTitle;
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta || line.isSidechain)
      return;
    const content = line.message?.content;
    const seq = i + 1;
    if (typeof content === "string") {
      if (line.type === "user" && !SYSTEM_TEXT.test(content) && content.trim()) {
        messages.push({ seq, role: "you", text: content, at: line.timestamp });
      }
      return;
    }
    if (!Array.isArray(content)) return;
    const texts = content.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text!);
    const tools = content
      .filter((b) => b.type === "tool_use")
      .map((b) => `${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 400)})`);
    if (line.type === "user") {
      const typed = texts.filter((t) => !SYSTEM_TEXT.test(t));
      if (typed.length)
        messages.push({ seq, role: "you", text: typed.join("\n\n"), at: line.timestamp });
    } else if (texts.length) {
      messages.push({ seq, role: "ai", text: texts.join("\n\n"), at: line.timestamp });
    } else if (tools.length) {
      messages.push({ seq, role: "tool", text: `Used ${tools.join("; ")}`, at: line.timestamp });
    }
  });
  return { messages, title, lines: complete.length };
}
