import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  RESERVATION_RESOURCES,
  RESOURCE_TEXT,
  reservationText,
  type HomelabRules as Rules,
  type Reservation,
  type ReservationResource,
} from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { Button, Section } from "../ui";

const fieldClass =
  "min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Settings > Ember > Homelab rules: the systems only you change (the AI is refused, even with an old
 * approval), and the times a machine or its GPU is yours, so long jobs and suggestions keep clear.
 */
export function HomelabRules() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = ws.data?.rules;
  const services = [...(ws.data?.services ?? []), ...(ws.data?.inactiveServices ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  const save = async (next: Rules) => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/settings/rules", {
        doNotTouch: next.doNotTouch.map(({ serviceId, reason }) => ({ serviceId, reason })),
        reservations: next.reservations,
        ...(next.notes !== undefined ? { notes: next.notes } : {}),
      });
      await qc.invalidateQueries({ queryKey: ["workspace"] });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!rules) return null;
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? id;
  const listed = new Set(rules.doNotTouch.map((d) => d.serviceId));

  return (
    <Section title="Homelab rules">
      <div className="space-y-10" data-testid="homelab-rules">
        <div>
          <h3 className="text-[0.95rem] text-ink">Do not touch</h3>
          <p className="mt-1 max-w-2xl text-[0.82rem] text-muted">
            Systems only you change. Your AI is refused any change to them, even one you approved
            before adding them here. It can still look at them.
          </p>
          {rules.doNotTouch.length ? (
            <ul className="mt-4 divide-y divide-line" aria-label="Do-not-touch list">
              {rules.doNotTouch.map((d) => (
                <li key={d.serviceId} className="flex min-h-12 items-center gap-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.9rem] text-ink">{nameOf(d.serviceId)}</p>
                    {d.reason && <p className="text-[0.8rem] text-faint">{d.reason}</p>}
                  </div>
                  <Button
                    tone="quiet"
                    disabled={busy}
                    aria-label={`Remove ${nameOf(d.serviceId)} from the do-not-touch list`}
                    onClick={() =>
                      void save({
                        ...rules,
                        doNotTouch: rules.doNotTouch.filter((x) => x.serviceId !== d.serviceId),
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-[0.85rem] text-faint">Nothing on the list.</p>
          )}
          <AddDoNotTouch
            services={services.filter((s) => !listed.has(s.id))}
            busy={busy}
            onAdd={(serviceId, reason) =>
              save({
                ...rules,
                doNotTouch: [
                  ...rules.doNotTouch,
                  { serviceId, reason, addedAt: new Date().toISOString() },
                ],
              })
            }
          />
        </div>

        <div>
          <h3 className="text-[0.95rem] text-ink">Reserved times</h3>
          <p className="mt-1 max-w-2xl text-[0.82rem] text-muted">
            When a machine, or its GPU, is yours: gaming, streaming, work. Your AI checks these
            before suggesting heavy work, and long jobs should finish before they start.
          </p>
          {rules.reservations.length ? (
            <ul className="mt-4 divide-y divide-line" aria-label="Reserved times">
              {rules.reservations.map((r) => (
                <li key={r.id} className="flex min-h-12 items-center gap-4 py-2">
                  <p className="min-w-0 flex-1 text-[0.9rem] text-ink">{reservationText(r)}</p>
                  <Button
                    tone="quiet"
                    disabled={busy}
                    aria-label={`Remove the reservation: ${reservationText(r)}`}
                    onClick={() =>
                      void save({
                        ...rules,
                        reservations: rules.reservations.filter((x) => x.id !== r.id),
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-[0.85rem] text-faint">No reserved times.</p>
          )}
          <AddReservation
            busy={busy}
            onAdd={(r) => save({ ...rules, reservations: [...rules.reservations, r] })}
          />
        </div>

        <OwnRules
          saved={rules.notes ?? ""}
          busy={busy}
          onSave={(notes) =>
            save({ doNotTouch: rules.doNotTouch, reservations: rules.reservations, notes })
          }
        />
        {error && (
          <p role="alert" className="text-[0.84rem] text-bad">
            {error}
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * Your own rules for Ember, in your words: they go with every message in the Lair. Rules you
 * added to the old Homelab project in the War Room were moved here.
 */
function OwnRules({
  saved,
  busy,
  onSave,
}: {
  saved: string;
  busy: boolean;
  onSave: (notes: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(saved);
  const [done, setDone] = useState(false);
  const [base, setBase] = useState(saved);
  // A save elsewhere (another device) shows here unless you are in the middle of an edit.
  if (saved !== base) {
    setBase(saved);
    if (text === base) setText(saved);
  }
  const changed = text.trim() !== saved.trim();
  return (
    <div>
      <h3 className="text-[0.95rem] text-ink">Your own rules</h3>
      <p className="mt-1 max-w-2xl text-[0.82rem] text-muted">
        Anything you want Ember to always keep in mind about your homelab, in your own words. They
        go with every message in the Lair. They never switch off an approval Hearth asks for.
      </p>
      <label htmlFor="own-rules" className="sr-only">
        Your own rules
      </label>
      <textarea
        id="own-rules"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDone(false);
        }}
        rows={5}
        maxLength={8000}
        placeholder="For example: ask before restarting the media server in the evening."
        className="mt-4 w-full max-w-3xl rounded-lg border border-line bg-panel px-3 py-2.5 text-[0.9rem] leading-snug text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
        data-testid="own-rules"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button
          disabled={busy || !changed}
          onClick={() => void onSave(text).then((ok) => setDone(ok))}
          data-testid="own-rules-save"
        >
          Save
        </Button>
        {done && !changed && <span className="text-[0.82rem] text-live">Saved</span>}
      </div>
    </div>
  );
}

function AddDoNotTouch({
  services,
  busy,
  onAdd,
}: {
  services: { id: string; name: string }[];
  busy: boolean;
  onAdd: (serviceId: string, reason: string) => Promise<boolean>;
}) {
  const [serviceId, setServiceId] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.4fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!serviceId) return;
        void onAdd(serviceId, reason.trim()).then((ok) => {
          if (ok) {
            setServiceId("");
            setReason("");
          }
        });
      }}
    >
      <label className="sr-only" htmlFor="dnt-service">
        System
      </label>
      <select
        id="dnt-service"
        value={serviceId}
        onChange={(e) => setServiceId(e.target.value)}
        className={fieldClass}
      >
        <option value="">Choose a system</option>
        {services.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="dnt-reason">
        Why (optional)
      </label>
      <input
        id="dnt-reason"
        value={reason}
        maxLength={200}
        placeholder="Reason (optional)"
        onChange={(e) => setReason(e.target.value)}
        className={fieldClass}
      />
      <Button type="submit" disabled={busy || !serviceId}>
        Add
      </Button>
    </form>
  );
}

function AddReservation({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (r: Reservation) => Promise<boolean>;
}) {
  const [machine, setMachine] = useState("");
  const [resource, setResource] = useState<ReservationResource>("gpu");
  const [from, setFrom] = useState("19:00");
  const [until, setUntil] = useState("23:00");
  const [days, setDays] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const toggle = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!machine.trim()) return;
        void onAdd({
          id: crypto.randomUUID(),
          machine: machine.trim(),
          resource,
          from,
          until,
          ...(days.length && days.length < 7 ? { days: [...days].sort() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }).then((ok) => {
          if (ok) {
            setMachine("");
            setNote("");
            setDays([]);
          }
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-[0.78rem] text-muted" htmlFor="res-machine">
            Machine
          </label>
          <input
            id="res-machine"
            value={machine}
            maxLength={80}
            placeholder="Machine name"
            onChange={(e) => setMachine(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-[0.78rem] text-muted" htmlFor="res-resource">
            What
          </label>
          <select
            id="res-resource"
            value={resource}
            onChange={(e) => setResource(e.target.value as ReservationResource)}
            className={fieldClass}
          >
            {RESERVATION_RESOURCES.map((r) => (
              <option key={r} value={r}>
                {RESOURCE_TEXT[r][0]!.toUpperCase() + RESOURCE_TEXT[r].slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[0.78rem] text-muted" htmlFor="res-from">
            From
          </label>
          <input
            id="res-from"
            type="time"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-[0.78rem] text-muted" htmlFor="res-until">
            Until
          </label>
          <input
            id="res-until"
            type="time"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className={fieldClass}
          />
        </div>
      </div>
      <fieldset>
        <legend className="mb-1 text-[0.78rem] text-muted">
          Days (none chosen means every day)
        </legend>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((label, d) => (
            <button
              key={label}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => toggle(d)}
              className={
                days.includes(d)
                  ? "min-h-11 min-w-11 rounded-lg border border-gold bg-gold/15 px-3 text-[0.84rem] text-ink"
                  : "min-h-11 min-w-11 rounded-lg border border-line px-3 text-[0.84rem] text-muted hover:text-ink"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="sr-only" htmlFor="res-note">
          Note (optional)
        </label>
        <input
          id="res-note"
          value={note}
          maxLength={120}
          placeholder="Note (optional)"
          onChange={(e) => setNote(e.target.value)}
          className={fieldClass}
        />
        <Button type="submit" disabled={busy || !machine.trim()}>
          Add reserved time
        </Button>
      </div>
    </form>
  );
}
