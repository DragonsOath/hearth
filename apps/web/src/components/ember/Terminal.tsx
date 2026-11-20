import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { emberSocketUrl } from "./engine";

/**
 * The terminal view: the real `claude` or `codex` running live in the project's folder on
 * Hearth's machine, through EMBER. Typing goes straight to it; voice can type into it too.
 */

const THEMES: Record<string, ITheme> = {
  "claude-code": {
    background: "#0b0d12",
    foreground: "#e6edf5",
    cursor: "#ff7a1a",
    cursorAccent: "#0b0d12",
    selectionBackground: "#ff7a1a55",
    black: "#1b1f27",
    red: "#ff6b6b",
    green: "#3ddc97",
    yellow: "#ffb347",
    blue: "#4fa3ff",
    magenta: "#c792ea",
    cyan: "#4fd1ff",
    white: "#e6edf5",
    brightBlack: "#5d6878",
    brightRed: "#ff8a8a",
    brightGreen: "#6ef0b5",
    brightYellow: "#ffd08a",
    brightBlue: "#7cc4ff",
    brightMagenta: "#ddb0ff",
    brightCyan: "#9be7ff",
    brightWhite: "#ffffff",
  },
  codex: {
    background: "#050b18",
    foreground: "#e3ecff",
    cursor: "#4fd8ff",
    cursorAccent: "#050b18",
    selectionBackground: "#1f7aff55",
    black: "#0c1730",
    red: "#ff6b6b",
    green: "#3ddc97",
    yellow: "#ffd27a",
    blue: "#1f7aff",
    magenta: "#b3a4ff",
    cyan: "#4fd8ff",
    white: "#e3ecff",
    brightBlack: "#5d6f94",
    brightRed: "#ff8a8a",
    brightGreen: "#6ef0b5",
    brightYellow: "#ffe2a8",
    brightBlue: "#6aa8ff",
    brightMagenta: "#d0c6ff",
    brightCyan: "#9eeaff",
    brightWhite: "#ffffff",
  },
};

export interface TerminalHandle {
  /** Types text into the session (voice, or a paste from elsewhere). */
  type: (text: string) => void;
}

export const EmberTerminal = forwardRef<
  TerminalHandle,
  { project: string; engine: string; engineLabel: string; where: string; active: boolean }
>(function EmberTerminal({ project, engine, engineLabel, where, active }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [ended, setEnded] = useState(false);
  const [gen, setGen] = useState(0);

  const send = (obj: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(obj));
  };

  useImperativeHandle(ref, () => ({
    type: (text: string) => {
      send({ t: "in", d: text + "\r" });
      term.current?.focus();
    },
  }));

  // One xterm for the page; its colors follow the engine.
  useEffect(() => {
    if (!host.current || term.current) return;
    const t = new XTerm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.15,
      scrollback: 10000,
      allowProposedApi: true,
      theme: THEMES[engine] ?? THEMES["claude-code"],
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon());
    t.open(host.current);
    t.onData((d) => send({ t: "in", d }));
    t.onResize(({ cols, rows }) => send({ t: "resize", cols, rows }));
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
      } catch {
        /* not visible yet */
      }
    });
    ro.observe(host.current);
    term.current = t;
    fit.current = f;
    return () => {
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.theme = THEMES[engine] ?? THEMES["claude-code"];
  }, [engine]);

  // A session per project and engine, opened while the terminal view shows.
  useEffect(() => {
    const t = term.current;
    if (!active || !t) return;
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      setEnded(false);
      t.reset();
      try {
        fit.current?.fit();
      } catch {
        /* sized on the next resize */
      }
      const sock = new WebSocket(
        emberSocketUrl("ws/term", {
          project,
          engine,
          cols: String(t.cols),
          rows: String(t.rows),
        }),
      );
      sock.binaryType = "arraybuffer";
      // The view may have just appeared: size to it once laid out, and tell the session.
      sock.onopen = () =>
        requestAnimationFrame(() => {
          try {
            fit.current?.fit();
          } catch {
            /* sized on the next resize */
          }
          send({ t: "resize", cols: t.cols, rows: t.rows });
        });
      sock.onmessage = (m: MessageEvent<ArrayBuffer | string>) => {
        if (typeof m.data !== "string") {
          t.write(new Uint8Array(m.data));
          return;
        }
        const d = JSON.parse(m.data) as { t: string; message?: string };
        if (d.t === "exit") setEnded(true);
        else if (d.t === "error") t.writeln(`\r\n\x1b[31m${d.message ?? "error"}\x1b[0m`);
      };
      // Dropped (EMBER restarted, the network blinked): reconnect to the same session.
      sock.onclose = () => {
        if (!closed) retry = window.setTimeout(open, 2500);
      };
      ws.current = sock;
      t.focus();
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      ws.current?.close();
      ws.current = null;
    };
  }, [active, project, engine, gen]);

  return (
    <div className="term-wrap" id="term-wrap" data-m="chat" data-testid="ember-terminal">
      <div className="term-head">
        <span>{engineLabel}</span>
        <span className="hint">{where}</span>
        <button
          type="button"
          className="btn small"
          title="End this session and start a fresh one"
          onClick={() => {
            if (window.confirm(`End this ${engineLabel} session and start a fresh one?`)) {
              send({ t: "restart" });
              term.current?.reset();
              term.current?.focus();
            }
          }}
        >
          New session
        </button>
      </div>
      <div id="term" ref={host} />
      {ended && (
        <div className="term-ended">
          <p>The session ended.</p>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              send({ t: "restart" });
              setEnded(false);
              term.current?.reset();
              term.current?.focus();
              if (ws.current?.readyState !== WebSocket.OPEN) setGen((g) => g + 1);
            }}
          >
            Start a new session
          </button>
        </div>
      )}
    </div>
  );
});
