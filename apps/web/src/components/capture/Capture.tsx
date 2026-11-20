import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Camera, Crop, MousePointerClick, PanelTop } from "lucide-react";
import type { CaptureContext, CaveAttachment } from "@dragon-control/core";
import { Button, cx } from "../ui";
import { api } from "../../data/api";
import { useCaptureFolder } from "../settings/CaptureFolderField";
import { captureElement, type Region } from "../../lib/capture";
import { useCave } from "../shell/cave-context";

/**
 * Contextual screenshots (feature request 19): a camera on each panel. Capture the whole panel,
 * one item in it, or a region you draw; review and annotate it; copy, save, or attach it to the
 * conversation. The same camera in the top bar captures the whole Hearth screen (11-17). Drawn from Hearth's own page: no screen-sharing permission, other apps
 * never visible, sensitive fields blanked.
 */

type PanelContext = Pick<CaptureContext, "serviceId" | "serviceName" | "panel" | "tab">;

interface Shot {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  context: CaptureContext;
}

/** The items a panel offers for "Pick an item". */
const ITEM = "[data-capture-item]";

export function CaptureButton({
  target,
  context,
  wholeLabel = "Whole panel",
  direct,
  screen,
}: {
  target: RefObject<HTMLElement | null>;
  context: PanelContext;
  /** The first choice's name ("Whole screen" for conversation mode's own camera). */
  wholeLabel?: string;
  /** One click captures the whole target, no menu (conversation mode's screen camera). */
  direct?: string;
  /** The whole Hearth screen: "Whole screen" is what is in the window now, not the full page. */
  screen?: boolean;
}) {
  const what = screen ? "the screen" : "this panel";
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<"pick" | "region" | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [shot, setShot] = useState<Shot | undefined>();
  const menuRef = useRef<HTMLDivElement>(null);
  const hasItems = () => Boolean(target.current?.querySelector(ITEM));

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const take = async (
    el: HTMLElement,
    extra: Pick<CaptureContext, "mode" | "item" | "region">,
    region?: Region,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      // Let the menu and overlays leave the screen first.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = await captureElement(el, region);
      setShot({
        blob: r.blob,
        url: URL.createObjectURL(r.blob),
        width: r.width,
        height: r.height,
        context: {
          ...context,
          ...extra,
          capturedAt: new Date().toISOString(),
          redacted: r.redacted,
          ...(r.metrics.length ? { metrics: r.metrics } : {}),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The capture did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative shrink-0" ref={menuRef} data-capture-skip>
      <button
        type="button"
        onClick={() => {
          if (direct) {
            if (target.current) void take(target.current, { mode: "panel" });
          } else setMenu((m) => !m);
        }}
        aria-label={direct ?? `Capture ${what}`}
        aria-expanded={direct ? undefined : menu}
        title={direct ?? `Capture ${what}`}
        data-testid={screen ? "capture-screen" : undefined}
        disabled={busy}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold disabled:opacity-40"
      >
        <Camera strokeWidth={1.5} className="h-[1.1rem] w-[1.1rem]" />
      </button>
      {menu && (
        <div
          role="menu"
          aria-label="Capture"
          className="absolute top-11 right-0 z-30 w-56 rounded-xl border border-gold/35 bg-panel p-1.5 shadow-xl"
        >
          {[
            { id: "panel", icon: PanelTop, label: wholeLabel, hint: "As it looks now" },
            {
              id: "pick",
              icon: MousePointerClick,
              label: "Pick an item",
              hint: "A row, card, or chart",
            },
            { id: "region", icon: Crop, label: "Draw a region", hint: "Drag over the area" },
          ].map((o) => {
            const disabled = o.id === "pick" && !hasItems();
            return (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  setMenu(false);
                  const el = target.current;
                  if (!el) return;
                  if (o.id === "panel")
                    void take(
                      el,
                      { mode: screen ? "screen" : "panel" },
                      screen ? inView(el) : undefined,
                    );
                  else setMode(o.id as "pick" | "region");
                }}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-raised disabled:opacity-40"
              >
                <o.icon strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" />
                <span>
                  <span className="block text-[0.86rem] text-ink">{o.label}</span>
                  <span className="block text-[0.72rem] text-faint">
                    {disabled ? `Nothing to pick in ${what}` : o.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="absolute top-11 right-0 z-30 w-56 rounded-lg bg-panel p-2 text-[0.76rem] text-bad"
        >
          {error}
        </p>
      )}
      {mode === "pick" && target.current && (
        <PickItem
          root={target.current}
          what={what}
          onCancel={() => setMode(undefined)}
          onPick={(el) => {
            setMode(undefined);
            void take(el, {
              mode: "item",
              item: (el.dataset.captureLabel ?? el.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200),
            });
          }}
        />
      )}
      {mode === "region" && target.current && (
        <DrawRegion
          root={target.current}
          what={what}
          onCancel={() => setMode(undefined)}
          onDone={(region) => {
            setMode(undefined);
            void take(target.current!, { mode: "region", region }, region);
          }}
        />
      )}
      {shot && (
        <CapturePreview
          shot={shot}
          onClose={() => {
            URL.revokeObjectURL(shot.url);
            setShot(undefined);
          }}
        />
      )}
    </div>
  );
}

/* ---------- Pick an item ---------- */

function Instructions({ text, onCancel }: { text: string; onCancel: () => void }) {
  return (
    <div
      className="fixed inset-x-0 top-3 z-[98] mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full border border-gold/50 bg-panel px-4 py-2 text-[0.84rem] text-ink shadow-xl"
      role="status"
      data-capture-skip
    >
      {text}
      <button
        type="button"
        onClick={onCancel}
        className="min-h-8 text-gold underline underline-offset-4"
      >
        Cancel
      </button>
    </div>
  );
}

/** The part of `el` inside the window now (a phone's page is taller than its screen). */
function inView(el: HTMLElement): Region {
  const r = el.getBoundingClientRect();
  const x = Math.max(0, -r.left);
  const y = Math.max(0, -r.top);
  return {
    x,
    y,
    width: Math.min(r.width - x, window.innerWidth - Math.max(0, r.left)),
    height: Math.min(r.height - y, window.innerHeight - Math.max(0, r.top)),
  };
}

function PickItem({
  root,
  what,
  onPick,
  onCancel,
}: {
  root: HTMLElement;
  what: string;
  onPick: (el: HTMLElement) => void;
  onCancel: () => void;
}) {
  const [box, setBox] = useState<DOMRect | undefined>();
  useEffect(() => {
    const itemAt = (t: EventTarget | null) => {
      const el = (t as Element | null)?.closest?.(ITEM) as HTMLElement | null;
      return el && root.contains(el) ? el : undefined;
    };
    const move = (e: PointerEvent) => setBox(itemAt(e.target)?.getBoundingClientRect());
    const click = (e: MouseEvent) => {
      const el = itemAt(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      onPick(el);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    root.addEventListener("pointermove", move);
    root.addEventListener("click", click, true);
    window.addEventListener("keydown", key);
    return () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key);
    };
  }, [root, onPick, onCancel]);
  return createPortal(
    <>
      <Instructions text={`Tap or click an item in ${what} to capture it.`} onCancel={onCancel} />
      {box && (
        <div
          aria-hidden="true"
          data-capture-skip
          className="pointer-events-none fixed z-[97] rounded-md border-2 border-gold bg-gold/10"
          style={{
            left: box.left - 2,
            top: box.top - 2,
            width: box.width + 4,
            height: box.height + 4,
          }}
        />
      )}
    </>,
    document.body,
  );
}

/* ---------- Draw a region ---------- */

function DrawRegion({
  root,
  what,
  onDone,
  onCancel,
}: {
  root: HTMLElement;
  what: string;
  onDone: (r: Region) => void;
  onCancel: () => void;
}) {
  const rect = root.getBoundingClientRect();
  const [start, setStart] = useState<{ x: number; y: number } | undefined>();
  const [end, setEnd] = useState<{ x: number; y: number } | undefined>();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  const local = (e: React.PointerEvent) => ({
    x: Math.min(Math.max(e.clientX - rect.left, 0), rect.width),
    y: Math.min(Math.max(e.clientY - rect.top, 0), rect.height),
  });
  const sel =
    start && end
      ? {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : undefined;
  return createPortal(
    <>
      <Instructions text={`Drag over the part of ${what} to capture.`} onCancel={onCancel} />
      <div
        data-capture-skip
        data-testid="capture-region"
        className="fixed z-[96] cursor-crosshair touch-none bg-black/25"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setStart(local(e));
          setEnd(local(e));
        }}
        onPointerMove={(e) => start && setEnd(local(e))}
        onPointerUp={() => {
          if (sel && sel.width > 8 && sel.height > 8) onDone(sel);
          else {
            setStart(undefined);
            setEnd(undefined);
          }
        }}
      >
        {sel && (
          <div
            className="absolute border-2 border-gold bg-gold/10"
            style={{ left: sel.x, top: sel.y, width: sel.width, height: sel.height }}
          />
        )}
      </div>
    </>,
    document.body,
  );
}

/* ---------- Preview: annotate, copy, save, attach ---------- */

interface Mark {
  tool: "pen" | "box";
  points: { x: number; y: number }[];
}

const INK = "#e05a4f";

/** Draws the capture and your marks onto the canvas. */
function paint(
  c: HTMLCanvasElement | null,
  img: HTMLImageElement | null,
  width: number,
  height: number,
  list: Mark[],
) {
  if (!c || !img) return;
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(3, width / 300);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const m of list) {
    if (m.tool === "box" && m.points.length > 1) {
      const [a, b] = [m.points[0]!, m.points.at(-1)!];
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (m.points.length) {
      ctx.beginPath();
      ctx.moveTo(m.points[0]!.x, m.points[0]!.y);
      for (const p of m.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
}

function CapturePreview({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const cave = useCave();
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tool, setTool] = useState<Mark["tool"]>("pen");
  const drawing = useRef<Mark | null>(null);
  const [status, setStatus] = useState<string | undefined>();
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    const img = new Image();
    img.onload = () => {
      image.current = img;
      paint(canvas.current, img, shot.width, shot.height, []);
    };
    img.src = shot.url;
  }, [shot.url, shot.width, shot.height]);

  const redraw = (list: Mark[], extra?: Mark) =>
    paint(canvas.current, image.current, shot.width, shot.height, extra ? [...list, extra] : list);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * shot.width,
      y: ((e.clientY - r.top) / r.height) * shot.height,
    };
  };
  const finalBlob = () =>
    new Promise<Blob>((resolve, reject) =>
      canvas.current!.toBlob((b) => (b ? resolve(b) : reject(new Error("No image"))), "image/png"),
    );

  // Settings > General > Screen captures: a folder on Hearth's computer, else the downloads.
  const folder = useCaptureFolder().data?.path ?? undefined;
  const base64 = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  const download = async () => {
    const blob = marks.length ? await finalBlob() : shot.blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hearth-capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus("Saved to your downloads.");
  };
  const saveToFolder = async () => {
    setStatus("Saving...");
    try {
      const blob = marks.length ? await finalBlob() : shot.blob;
      const r = await api<{ file: string }>("POST", "/api/captures", { data: await base64(blob) });
      setStatus(`Saved as ${r.file}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "It could not be saved.");
    }
  };

  const attach = async () => {
    setAttaching(true);
    setStatus(undefined);
    try {
      const blob = marks.length ? await finalBlob() : shot.blob;
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const a = await api<CaveAttachment>("POST", "/api/attachments", {
        data,
        width: shot.width,
        height: shot.height,
        context: shot.context,
      });
      cave.attach(a);
      dialog.current?.close();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "It could not be attached.");
    } finally {
      setAttaching(false);
    }
  };

  const c = shot.context;
  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Capture preview"
      onClose={onClose}
      data-capture-skip
      className="m-auto w-[min(56rem,calc(100vw-1.5rem))] rounded-2xl border border-gold/40 bg-panel p-4 text-ink backdrop:bg-black/75 sm:p-5"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-display text-[1.3rem]">Capture</h2>
        <div role="group" aria-label="Mark up" className="flex gap-1">
          {(["pen", "box"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tool === t}
              onClick={() => setTool(t)}
              className={cx(
                "min-h-9 rounded-lg border px-3 text-[0.8rem]",
                tool === t ? "border-gold/60 text-gold" : "border-line text-muted hover:text-ink",
              )}
            >
              {t === "pen" ? "Pen" : "Box"}
            </button>
          ))}
          <button
            type="button"
            disabled={!marks.length}
            onClick={() => {
              const next = marks.slice(0, -1);
              setMarks(next);
              redraw(next);
            }}
            className="min-h-9 rounded-lg border border-line px-3 text-[0.8rem] text-muted hover:text-ink disabled:opacity-40"
          >
            Undo
          </button>
        </div>
      </div>
      <div
        className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-bg focus:outline-none focus-visible:ring-1 focus-visible:ring-gold"
        tabIndex={0}
        role="region"
        aria-label="Captured image"
      >
        <canvas
          ref={canvas}
          data-testid="capture-canvas"
          aria-label="The captured image; draw on it to mark things up"
          className="block h-auto w-full touch-none cursor-crosshair"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = { tool, points: [at(e)] };
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = at(e);
            drawing.current =
              drawing.current.tool === "box"
                ? { tool: "box", points: [drawing.current.points[0]!, p] }
                : { ...drawing.current, points: [...drawing.current.points, p] };
            redraw(marks, drawing.current);
          }}
          onPointerUp={() => {
            if (!drawing.current) return;
            const next = [...marks, drawing.current];
            drawing.current = null;
            setMarks(next);
            redraw(next);
          }}
        />
      </div>
      <p className="mt-2 text-[0.76rem] text-muted" data-testid="capture-context">
        {c.mode === "screen"
          ? `The whole screen${c.panel ? ` (${c.panel})` : ""}`
          : c.mode === "region"
            ? "A region"
            : c.mode === "item"
              ? `Item: ${c.item ?? ""}`
              : "The whole panel"}
        {c.panel && c.mode !== "screen" ? ` of ${c.panel}` : ""}
        {c.tab ? ` (${c.tab})` : ""} · {new Date(c.capturedAt).toLocaleTimeString()}
        {c.redacted
          ? ` · ${c.redacted} sensitive ${c.redacted === 1 ? "item was" : "items were"} left out`
          : ""}
      </p>
      <p className="mt-1 text-[0.74rem] text-faint">
        Stays on your Hearth. Attaching sends it to the AI provider only with your next message,
        when Ember looks at it. Check that nothing private is visible first.
      </p>
      {status && (
        <p role="status" className="mt-2 text-[0.8rem] text-gold">
          {status}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button tone="quiet" onClick={() => dialog.current?.close()}>
          Discard
        </Button>
        <Button
          onClick={() =>
            void (async () => {
              try {
                const blob = marks.length ? await finalBlob() : shot.blob;
                await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                setStatus("Copied as an image.");
              } catch {
                setStatus("This browser did not allow copying an image; use Save instead.");
              }
            })()
          }
        >
          Copy
        </Button>
        {folder && (
          <Button tone="quiet" onClick={() => void download()} data-testid="capture-download">
            Download
          </Button>
        )}
        <Button
          onClick={() => void (folder ? saveToFolder() : download())}
          title={folder ? `Save to ${folder}` : "Save to your downloads"}
          data-testid="capture-save"
        >
          Save
        </Button>
        <Button tone="primary" disabled={attaching} onClick={() => void attach()}>
          {attaching ? "Attaching..." : "Attach to conversation"}
        </Button>
      </div>
    </dialog>,
    document.body,
  );
}
