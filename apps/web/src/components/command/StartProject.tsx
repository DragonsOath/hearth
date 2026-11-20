import { useEffect, useId, useRef, useState } from "react";
import type { ProjectColor } from "@dragon-control/core";
import { ProjectColorPicker } from "./ProjectColorPicker";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Castle, Swords } from "lucide-react";
import { api, useWorkspace } from "../../data/api";
import { pcLook, usePcs } from "../../data/pcs";
import { useCreateProject } from "../../data/projects";
import { warRoomProjectHref } from "../../data/warRoomProjects";
import { useEmberLink } from "../../pages/WarRoom";
import { Button, cx } from "../ui";
import { PcChip, type Zone } from "./zones";
import { usePhone } from "../../lib/media";

const inputClass =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink placeholder:text-faint focus:border-gold focus:outline-none";

/**
 * Start a project from Home (10-30). First, who works on it: the Lair (homelab work, Ember
 * with Hearth's live tools and approvals) or the War Room (building something: Claude Code, Codex
 * or Ollama in a project folder). Then its name, what it is, and which PC. Both kinds show on Home.
 */
export function StartProject({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ws = useWorkspace();
  const pcs = usePcs();
  const link = useEmberLink();
  const warRoom = Boolean(link.data?.configured && link.data.reachable);
  // No War Room on a phone (11-13): a project there starts in the Lair.
  const phone = usePhone();
  const createLair = useCreateProject();
  const [zone, setZone] = useState<Zone>("lair");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [color, setColor] = useState<ProjectColor | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  // The Lair: the machines Hearth watches (the work is about one of them).
  const hosts = ws.data?.hosts ?? [];
  const here = hosts.find((h) => h.connection === "this-machine") ?? hosts[0];
  // The War Room: the PCs in your Hearth that are on (a project's folder lives on one).
  const machines = [
    ...(pcs.data ? [{ pc: null as string | null, info: pcs.data.hub }] : []),
    ...(pcs.data?.pcs ?? []).filter((p) => p.online).map((p) => ({ pc: p.id, info: p })),
  ];
  const [hostId, setHostId] = useState<string | undefined>();
  const [pc, setPc] = useState<string | null>(null);
  const chosenHost = hostId ?? here?.id;
  const lookOf = (n: string) => {
    const all = pcs.data ? [pcs.data.hub, ...pcs.data.pcs] : [];
    const match = all.find((p) => p.name.toLowerCase() === n.toLowerCase());
    return match
      ? { name: n, ...pcLook(match) }
      : { name: n, src: null, color: "var(--color-muted)" };
  };

  const start = async () => {
    const title = name.trim();
    if (!title) return setError("Give it a name.");
    setBusy(true);
    setError(null);
    try {
      if (zone === "lair") {
        const p = await createLair.mutateAsync({
          name: title,
          ...(about.trim() ? { summary: about.trim() } : {}),
          ...(color ? { color } : {}),
          ...(chosenHost ? { related: [{ kind: "host" as const, id: chosenHost }] } : {}),
        });
        navigate(`/?project=${encodeURIComponent(p.id)}`);
      } else {
        const p = await api<{ slug: string }>(
          "POST",
          pc ? `/api/on/${pc}/engine/projects` : "/api/engine/projects",
          { name: title, description: about.trim(), ...(color ? { color } : {}) },
        );
        await qc.invalidateQueries({ queryKey: ["war-room-projects"] });
        navigate(warRoomProjectHref(p.slug, pc));
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The project could not be started.");
    } finally {
      setBusy(false);
    }
  };

  const choice = (z: Zone, disabled = false) => {
    const lair = z === "lair";
    const Icon = lair ? Castle : Swords;
    const picked = zone === z;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={picked}
        disabled={disabled}
        onClick={() => setZone(z)}
        className={cx(
          "flex flex-col items-start rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          picked
            ? lair
              ? "border-2 border-tint-teal bg-tint-teal/10"
              : "border-2 border-gold bg-gold/10"
            : "border-line-strong hover:border-gold/50",
        )}
        data-testid={`start-zone-${z}`}
      >
        <span className="flex items-center gap-2 font-semibold text-ink">
          <Icon
            strokeWidth={1.75}
            className={cx("h-5 w-5", lair ? "text-tint-teal" : "text-gold")}
            aria-hidden="true"
          />
          {lair ? "The Lair" : "War Room"}
        </span>
        <span className="mt-2 text-[0.8rem] leading-snug text-muted">
          {lair
            ? "Homelab work: your apps, drives, media and settings. Ember in the Lair does it, with live Hearth tools, and asks before anything risky."
            : disabled
              ? "Building something: an app, a website, a script. The War Room isn't running on this Hearth right now."
              : "Building something: an app, a website, a script. Claude Code, Codex or Ollama work in its own project folder."}
        </span>
      </button>
    );
  };

  const pcButton = (
    key: string,
    where: Parameters<typeof PcChip>[0]["where"],
    on: boolean,
    pick: () => void,
  ) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      onClick={pick}
      className={cx(
        "inline-flex min-h-10 items-center rounded-full border px-3.5 text-[0.85rem]",
        on ? "border-2 border-gold text-ink" : "border-line-strong text-muted hover:text-ink",
      )}
    >
      <PcChip where={where} />
    </button>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-2xl border border-gold/40 bg-panel p-6 text-ink backdrop:bg-black/70"
      data-testid="start-project"
    >
      <h2 id={titleId} className="font-display text-[1.35rem] leading-tight text-gold">
        Start a project
      </h2>
      <p className="mt-1 text-[0.85rem] text-muted">Who should work on it?</p>
      <div
        role="radiogroup"
        aria-label="Who works on it"
        className="mt-3 grid gap-3 sm:grid-cols-2"
      >
        {choice("lair")}
        {!phone && choice("war-room", !warRoom)}
      </div>

      <label className="mt-5 block text-[0.8rem] text-muted">
        Project Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className={inputClass}
          data-testid="start-name"
        />
      </label>
      <label className="mt-3 block text-[0.8rem] text-muted">
        Project Description
        <input
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          maxLength={1000}
          className={inputClass}
          data-testid="start-about"
        />
      </label>

      <p className="mt-3 text-[0.8rem] text-muted">Color on Home</p>
      <div className="mt-1.5">
        <ProjectColorPicker value={color} onChange={setColor} />
      </div>

      <p className="mt-3 text-[0.8rem] text-muted">
        {zone === "lair" ? "Which machine is it about?" : "Which PC should it live on?"}
      </p>
      <div
        role="radiogroup"
        aria-label="Which PC"
        className="mt-1.5 flex flex-wrap gap-2"
        data-testid="start-pc"
      >
        {zone === "lair"
          ? hosts.map((h) =>
              pcButton(h.id, lookOf(h.name), chosenHost === h.id, () => setHostId(h.id)),
            )
          : machines.map((m) =>
              pcButton(m.pc ?? "hub", { name: m.info.name, ...pcLook(m.info) }, pc === m.pc, () =>
                setPc(m.pc),
              ),
            )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[0.84rem] text-bad">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-3">
        <Button tone="quiet" onClick={() => ref.current?.close()}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !name.trim()}
          onClick={() => void start()}
          data-testid="start-submit"
        >
          {zone === "lair" ? "Start in the Lair" : "Start in the War Room"}
        </Button>
      </div>
    </dialog>
  );
}
