import { useMemo, useState } from "react";
import {
  Film,
  House,
  Moon,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Sunrise,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  useScene,
  useSceneChange,
  type SceneChoice,
  type SceneDetail,
  type SceneItem,
} from "../../data/home";
import { Modal } from "../workspace/dialogs";
import { Panel, type Ctx } from "./parts";

/**
 * The Scenes widget (11-05: "I also should be able to add scenes directly from the widget
 * ... edit them or add a new one or delete one"). A tap still runs a scene; the pencil opens it
 * to change, and New makes one. A scene opens as its devices, each on or off with a brightness
 * and colour where the light has them; steps Hearth doesn't edit (a TV input, a voice command,
 * a wait) are listed and kept as they are. Saved in Home Assistant itself, so its own scene
 * list, voice assistants and automations see the change too.
 */

const sceneIcon = (name: string) => {
  const n = name.toLowerCase();
  if (/morning|wake|sunrise/.test(n)) return <Sunrise style={{ color: "var(--hd-ember-hi)" }} />;
  if (/movie|film|tv|cinema/.test(n)) return <Film style={{ color: "#a58bff" }} />;
  if (/night|sleep|bed/.test(n)) return <Moon style={{ color: "#a58bff" }} />;
  if (/leav|away|out/.test(n)) return <House style={{ color: "#8ec5ff" }} />;
  return <Sparkles style={{ color: "var(--hd-ember-hi)" }} />;
};

export function ScenesPanel({ c, className }: { c: Ctx; className?: string }) {
  const { d, tap, busy } = c;
  // The scene open in the editor: an entity, "new", or none.
  const [open, setOpen] = useState<string>();
  return (
    <Panel
      title="Scenes"
      icon={<Zap />}
      testId="home-scenes"
      className={className}
      action={
        <button
          type="button"
          className="hd-chip"
          onClick={() => setOpen("new")}
          data-testid="home-scene-new"
        >
          <Plus size={16} /> New
        </button>
      }
    >
      {!d.scenes.length ? (
        <p className="hd-empty">No scenes yet. Make one with New.</p>
      ) : (
        <div className="hd-scenes">
          {d.scenes.map((s) => (
            <div key={s.entity} className="hd-scene-tile" data-testid="home-scene-tile">
              <button
                type="button"
                className="hd-scene-btn"
                disabled={busy}
                onClick={() =>
                  tap({
                    entity: s.entity,
                    action: s.entity.startsWith("scene.") ? "activate" : "run",
                  })
                }
              >
                {sceneIcon(s.name)}
                <span>{s.name}</span>
              </button>
              <button
                type="button"
                className="hd-scene-edit"
                aria-label={`Change ${s.name}`}
                title="Change"
                onClick={() => setOpen(s.entity)}
                data-testid="home-scene-edit"
              >
                <Pencil size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <SceneWindow
          c={c}
          entity={open === "new" ? undefined : open}
          onClose={() => setOpen(undefined)}
        />
      )}
    </Panel>
  );
}

type Row =
  | ({ kind: "device"; key: string; ref?: string } & Omit<
      Extract<SceneItem, { kind: "device" }>,
      "kind" | "ref"
    >)
  | { kind: "other"; key: string; ref: string; summary: string };

const hex = (c?: [number, number, number]) =>
  c ? `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}` : "#ffffff";
const rgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

function SceneWindow({ c, entity, onClose }: { c: Ctx; entity?: string; onClose: () => void }) {
  const q = useScene(c.d.serviceId, entity);
  return (
    <Modal title={entity ? (q.data?.name ?? "Scene") : "New scene"} onCancel={onClose}>
      <div className="mt-3 space-y-3" data-testid="home-scene-window">
        {q.isPending ? (
          <p className="text-[0.9rem] text-muted">Opening it in Home Assistant…</p>
        ) : q.isError ? (
          <p className="text-[0.88rem] text-amber" role="alert">
            {q.error.message}
          </p>
        ) : (
          <SceneForm c={c} scene={q.data} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}

function SceneForm({ c, scene, onClose }: { c: Ctx; scene: SceneDetail; onClose: () => void }) {
  const change = useSceneChange(c.d.serviceId);
  const [name, setName] = useState(scene.name);
  const [rows, setRows] = useState<Row[]>(() =>
    scene.items.map((it, i) =>
      it.kind === "device" ? { ...it, key: `r${i}` } : { ...it, key: `r${i}` },
    ),
  );
  const [err, setErr] = useState<string>();
  const [sure, setSure] = useState(false);
  const choice = useMemo(() => new Map(scene.choices.map((x) => [x.entity, x])), [scene.choices]);
  const used = new Set(rows.flatMap((r) => (r.kind === "device" ? [r.entity] : [])));
  const free = scene.choices.filter((x) => !used.has(x.entity));
  const rooms = useMemo(() => {
    const m = new Map<string, SceneChoice[]>();
    for (const x of free) m.set(x.room ?? "Other", [...(m.get(x.room ?? "Other") ?? []), x]);
    return [...m.entries()].sort(([a], [b]) =>
      a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b),
    );
  }, [free]);
  const set = (key: string, patch: Partial<Extract<Row, { kind: "device" }>>) =>
    setRows((rs) => rs.map((r) => (r.key === key && r.kind === "device" ? { ...r, ...patch } : r)));

  if (!scene.editable)
    return (
      <>
        <p className="text-[0.9rem] text-ink">{scene.why}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            className="hd-pill"
            onClick={() => {
              c.tap({
                entity: scene.entity!,
                action: scene.entity!.startsWith("scene.") ? "activate" : "run",
              });
              onClose();
            }}
          >
            <Play size={16} /> Run it
          </button>
        </div>
      </>
    );

  const save = () => {
    setErr(undefined);
    if (!name.trim()) return setErr("Give the scene a name.");
    if (!rows.length) return setErr("Add at least one device.");
    change.mutate(
      {
        action: "save",
        ...(scene.entity ? { entity: scene.entity } : {}),
        name: name.trim(),
        items: rows.map((r) =>
          r.kind === "other"
            ? { ref: r.ref, keep: true as const }
            : {
                ...(r.ref !== undefined ? { ref: r.ref } : {}),
                entity: r.entity,
                on: r.on,
                ...(r.on && r.brightness !== undefined ? { brightness: r.brightness } : {}),
                ...(r.on && r.color ? { color: r.color } : {}),
              },
        ),
      },
      { onSuccess: onClose, onError: (e) => setErr(e.message) },
    );
  };
  const remove = () => {
    if (!scene.entity) return;
    setErr(undefined);
    change.mutate(
      { action: "delete", entity: scene.entity },
      { onSuccess: onClose, onError: (e) => setErr(e.message) },
    );
  };
  const field =
    "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {err && (
        <p className="text-[0.88rem] text-amber" role="alert">
          {err}
        </p>
      )}
      <label className="block text-[0.84rem] text-muted">
        Name
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Movie time"
          autoFocus={!scene.entity}
          data-testid="home-scene-name"
        />
      </label>

      <div className="space-y-2" data-testid="home-scene-rows">
        {!rows.length && (
          <p className="text-[0.85rem] text-muted">No devices yet. Add one below.</p>
        )}
        {rows.map((r) =>
          r.kind === "other" ? (
            <div key={r.key} className="hd-scene-row" data-kept>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.88rem] text-ink">{r.summary}</p>
                <p className="text-[0.75rem] text-faint">Kept as it is</p>
              </div>
              <button
                type="button"
                className="hd-scene-x"
                aria-label={`Take out: ${r.summary}`}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <DeviceRow
              key={r.key}
              row={r}
              info={choice.get(r.entity)}
              onChange={(p) => set(r.key, p)}
              onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            />
          ),
        )}
      </div>

      {free.length > 0 && (
        <label className="block text-[0.84rem] text-muted">
          Add a device
          <select
            className={field}
            value=""
            data-testid="home-scene-add"
            onChange={(e) => {
              const x = choice.get(e.target.value);
              if (!x) return;
              setRows((rs) => [
                ...rs,
                { kind: "device", key: `n${Date.now()}`, entity: x.entity, on: true },
              ]);
            }}
          >
            <option value="">Pick a light, switch or TV…</option>
            {rooms.map(([room, list]) => (
              <optgroup key={room} label={room}>
                {list.map((x) => (
                  <option key={x.entity} value={x.entity}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          className="hd-pill"
          disabled={change.isPending}
          data-testid="home-scene-save"
        >
          {change.isPending ? "Saving…" : scene.entity ? "Save" : "Add scene"}
        </button>
        {scene.entity &&
          (sure ? (
            <>
              <span className="text-[0.85rem] text-ink">Delete {scene.name}?</span>
              <button
                type="button"
                className="hd-pill"
                disabled={change.isPending}
                onClick={remove}
                data-testid="home-scene-delete-yes"
              >
                Yes, delete
              </button>
              <button type="button" className="hd-pill" onClick={() => setSure(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              className="hd-pill"
              onClick={() => setSure(true)}
              data-testid="home-scene-delete"
            >
              <Trash2 size={16} /> Delete
            </button>
          ))}
      </div>
      <p className="text-[0.75rem] text-faint">Saved in Home Assistant.</p>
    </form>
  );
}

function DeviceRow({
  row,
  info,
  onChange,
  onRemove,
}: {
  row: Extract<Row, { kind: "device" }>;
  info?: SceneChoice;
  onChange: (p: Partial<Extract<Row, { kind: "device" }>>) => void;
  onRemove: () => void;
}) {
  const name = info?.name ?? row.entity;
  return (
    <div className="hd-scene-row" data-testid="home-scene-device">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.9rem] text-ink">{name}</p>
            {info?.room && <p className="text-[0.75rem] text-faint">{info.room}</p>}
          </div>
          <div className="hd-onoff" role="group" aria-label={`${name} on or off`}>
            <button type="button" aria-pressed={row.on} onClick={() => onChange({ on: true })}>
              On
            </button>
            <button type="button" aria-pressed={!row.on} onClick={() => onChange({ on: false })}>
              Off
            </button>
          </div>
        </div>
        {row.on && info?.dim && (
          <label className="flex items-center gap-3 text-[0.8rem] text-muted">
            <span className="w-24 flex-none">
              {row.brightness === undefined
                ? "Brightness: as it was"
                : `Brightness ${row.brightness}%`}
            </span>
            <input
              type="range"
              min={1}
              max={100}
              value={row.brightness ?? 100}
              onChange={(e) => onChange({ brightness: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-[var(--hd-ember-hi)]"
              aria-label={`${name} brightness`}
            />
          </label>
        )}
        {row.on && info?.color && (
          <div className="flex items-center gap-3 text-[0.8rem] text-muted">
            <span className="w-24 flex-none">{row.color ? "Colour" : "Colour: as it was"}</span>
            <input
              type="color"
              value={hex(row.color)}
              onChange={(e) => onChange({ color: rgb(e.target.value) })}
              className="hd-scene-color"
              aria-label={`${name} colour`}
            />
            {row.color && (
              <button
                type="button"
                className="text-[0.78rem] text-muted underline"
                onClick={() => onChange({ color: undefined })}
              >
                No colour
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="hd-scene-x"
        aria-label={`Take ${name} out`}
        onClick={onRemove}
      >
        <X size={16} />
      </button>
    </div>
  );
}
