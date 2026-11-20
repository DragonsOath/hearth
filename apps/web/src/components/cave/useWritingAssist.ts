import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { GrammarSuggestion } from "../../lib/grammar";
import { correct, type Correction, type WritingMode } from "../../lib/writing";
import { isTouchOnly } from "../../lib/media";

/**
 * Basic writing assistance in the Ember message box (lib/writing.ts),
 * per device: corrections land only when a sentence ends or after a short
 * pause, never mid-word, and never while a phone keyboard is composing. Each
 * correction is one ordinary edit (Ctrl+Z undoes it) and the chip under the
 * box offers Undo too; undone words are left alone for the rest of the message.
 * Enhanced also asks Harper (lib/grammar.ts, in the browser) for grammar
 * suggestions after the same pause; those are only offered, never applied.
 */

export const WRITING_MODE_KEY = "dc-writing-assist";
const PAUSE_MS = 1500;

export function readWritingMode(): WritingMode {
  try {
    const v = localStorage.getItem(WRITING_MODE_KEY);
    if (v === "off" || v === "basic" || v === "enhanced") return v;
  } catch {
    // Storage unavailable: use the default below.
  }
  // Phones and tablets already correct as you type; desktops get Basic.
  return isTouchOnly() ? "off" : "basic";
}

export function writeWritingMode(mode: WritingMode) {
  try {
    localStorage.setItem(WRITING_MODE_KEY, mode);
  } catch {
    // Not saved; it applies until the page reloads.
  }
}

interface Applied {
  before: string;
  after: string;
  /** Where the corrected part ended, before and after the correction. */
  headBefore: number;
  headAfter: number;
  changes: Correction[];
}

export function useWritingAssist(o: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setDraft: (text: string) => void;
  vocabulary: string[];
}) {
  const [mode, setModeState] = useState<WritingMode>(readWritingMode);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [grammar, setGrammar] = useState<GrammarSuggestion[]>([]);
  const [grammarState, setGrammarState] = useState<"idle" | "loading" | "failed">("idle");
  /** Suggestions dismissed in this message (by the text and the advice). */
  const dismissed = useRef(new Set<string>());
  const checkId = useRef(0);
  const ignore = useRef(new Set<string>());
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const vocabulary = useRef(o.vocabulary);
  useEffect(() => {
    vocabulary.current = o.vocabulary;
  });

  // Settings may change on another page; pick it up when the box is used again.
  useEffect(() => {
    const sync = () => setModeState(readWritingMode());
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = useCallback(() => {
    const el = o.inputRef.current;
    if (!el || mode === "off" || composing.current) return;
    if (el.selectionStart !== el.selectionEnd || document.activeElement !== el) return;
    const caret = el.selectionStart;
    const before = el.value;
    const r = correct(before, {
      upTo: caret,
      includeLast: true,
      vocabulary: vocabulary.current,
      ignore: ignore.current,
    });
    if (!r.changes.length) return;
    const head = r.text.slice(0, caret + r.delta);
    // One ordinary edit, so the browser's own undo (Ctrl+Z) reverses it.
    el.setSelectionRange(0, caret);
    const native = document.execCommand?.("insertText", false, head);
    if (!native || el.value !== r.text) o.setDraft(r.text);
    requestAnimationFrame(() => el.setSelectionRange(head.length, head.length));
    setApplied({
      before,
      after: r.text,
      headBefore: caret,
      headAfter: head.length,
      changes: r.changes,
    });
  }, [mode, o]);

  const checkGrammarNow = useCallback(() => {
    const el = o.inputRef.current;
    if (!el || mode !== "enhanced" || composing.current) return;
    const text = el.value;
    const id = ++checkId.current;
    if (!text.trim()) return setGrammar([]);
    setGrammarState((st) => (st === "idle" ? "loading" : st));
    import("../../lib/grammar")
      .then(({ checkGrammar }) => checkGrammar(text, vocabulary.current))
      .then((found) => {
        // Only if nothing was typed while it was checking.
        if (id !== checkId.current || o.inputRef.current?.value !== text) return;
        setGrammarState("idle");
        setGrammar(found.filter((g) => !dismissed.current.has(`${g.original}|${g.message}`)));
      })
      .catch(() => {
        if (id === checkId.current) setGrammarState("failed");
      });
  }, [mode, o.inputRef]);

  const applyGrammar = useCallback(
    (g: GrammarSuggestion, replacement: string) => {
      const el = o.inputRef.current;
      if (!el) return;
      void import("../../lib/grammar").then(({ applySuggestion }) => {
        const next = applySuggestion(el.value, g, replacement);
        if (next === undefined) return setGrammar([]);
        el.focus();
        el.setSelectionRange(g.start, g.end);
        // One ordinary edit, so Ctrl+Z reverses it.
        const native = document.execCommand?.("insertText", false, replacement);
        if (!native || el.value !== next) o.setDraft(next);
        const caret = g.start + replacement.length;
        requestAnimationFrame(() => el.setSelectionRange(caret, caret));
        setGrammar([]);
        clearTimeout(timer.current);
        timer.current = setTimeout(checkGrammarNow, 300);
      });
    },
    [o, checkGrammarNow],
  );

  const dismissGrammar = useCallback((g: GrammarSuggestion) => {
    dismissed.current.add(`${g.original}|${g.message}`);
    setGrammar((list) => list.filter((x) => x !== g));
  }, []);

  /** Call from the box's onChange with the native event. */
  const onInput = useCallback(
    (value: string, ev: Event) => {
      clearTimeout(timer.current);
      if (mode === "off") return;
      // What was suggested was for the text before this edit.
      checkId.current++;
      setGrammar((g) => (g.length ? [] : g));
      // Drop the Undo offer once the corrected part itself has been edited.
      setApplied((a) => (a && !value.startsWith(a.after.slice(0, a.headAfter)) ? null : a));
      const input = ev as InputEvent;
      const el = o.inputRef.current;
      const caret = el?.selectionStart ?? value.length;
      const justEnded =
        (input.inputType === "insertText" && input.data === " ") ||
        input.inputType === "insertLineBreak";
      const both = () => {
        run();
        checkGrammarNow();
      };
      if (justEnded && /[.!?]\s$/.test(value.slice(0, caret))) {
        both();
        return;
      }
      timer.current = setTimeout(both, PAUSE_MS);
    },
    [mode, o.inputRef, run, checkGrammarNow],
  );

  const undo = useCallback(() => {
    const el = o.inputRef.current;
    if (!el || !applied) return;
    const now = el.value;
    if (!now.startsWith(applied.after.slice(0, applied.headAfter))) return setApplied(null);
    const restored = applied.before.slice(0, applied.headBefore) + now.slice(applied.headAfter);
    for (const c of applied.changes) ignore.current.add(c.from);
    el.focus();
    el.setSelectionRange(0, applied.headAfter);
    const native = document.execCommand?.(
      "insertText",
      false,
      applied.before.slice(0, applied.headBefore),
    );
    if (!native || el.value !== restored) o.setDraft(restored);
    setApplied(null);
  }, [applied, o]);

  /** A new message: forget undone words and the pending correction. */
  const reset = useCallback(() => {
    clearTimeout(timer.current);
    ignore.current.clear();
    dismissed.current.clear();
    checkId.current++;
    setApplied(null);
    setGrammar([]);
  }, []);

  return {
    mode,
    applied,
    undo,
    reset,
    onInput,
    dismiss: () => setApplied(null),
    grammar: mode === "enhanced" ? grammar : [],
    grammarState: mode === "enhanced" ? grammarState : ("idle" as const),
    applyGrammar,
    dismissGrammar,
    composition: {
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: () => {
        composing.current = false;
      },
    },
  };
}
