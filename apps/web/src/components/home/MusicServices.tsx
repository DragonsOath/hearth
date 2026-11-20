import { useEffect, useState } from "react";
import { Check, ExternalLink, Search } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../data/api";
import { Button } from "../ui";

/**
 * Add a music service (11-05): every service Music Assistant has, added from here with
 * Music Assistant's own setup for it, shown a step at a time. A sign-in page opens in a new
 * tab; Music Assistant hears back from it and the setup moves on by itself. YouTube Music
 * keeps Hearth's own setup (onYoutube).
 */

interface Service {
  domain: string;
  name: string;
  description?: string;
  added: boolean;
  more: boolean;
  beta: boolean;
  kind: "streaming" | "library" | "radio" | "podcasts" | "audiobooks" | "files";
}
interface Field {
  key: string;
  type: "text" | "secret" | "boolean" | "number" | "choice" | "note";
  label: string;
  required: boolean;
  description?: string;
  value?: string | number | boolean;
  options?: { title: string; value: string | number }[];
}
interface Step {
  flowId?: string;
  stepId: string;
  type: "form" | "external" | "progress" | "finish" | "abort";
  fields: Field[];
  errors: Record<string, string>;
  url?: string;
  text?: string;
  reason?: string;
}

const KINDS: { kind: Service["kind"]; title: string }[] = [
  { kind: "streaming", title: "Music services" },
  { kind: "library", title: "Your own media servers" },
  { kind: "files", title: "Music files" },
  { kind: "radio", title: "Radio" },
  { kind: "podcasts", title: "Podcasts" },
  { kind: "audiobooks", title: "Audiobooks" },
];

const input =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

const post = (body: Record<string, unknown>) => api<Step>("POST", "/api/home/music/services", body);

export function MusicServices({
  onYoutube,
  onDone,
}: {
  onYoutube: () => void;
  onDone: () => void;
}) {
  const q = useQuery({
    queryKey: ["home-music-services"],
    queryFn: () => api<{ linked: boolean; services: Service[] }>("GET", "/api/home/music/services"),
  });
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Service>();
  const [find, setFind] = useState("");
  if (q.isPending) return <p className="text-[0.88rem] text-muted">Asking Music Assistant…</p>;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-amber" role="alert">
        {q.error.message}
      </p>
    );
  if (picked)
    return (
      <ServiceSetup
        service={picked}
        onBack={() => {
          setPicked(undefined);
          void qc.invalidateQueries({ queryKey: ["home-music-services"] });
        }}
        onDone={() => {
          void qc.invalidateQueries({ queryKey: ["home-music"] });
          void qc.invalidateQueries({ queryKey: ["home-music-services"] });
          onDone();
        }}
      />
    );
  const all = q.data?.services ?? [];
  const shown = find.trim()
    ? all.filter((s) =>
        `${s.name} ${s.description ?? ""}`.toLowerCase().includes(find.trim().toLowerCase()),
      )
    : all;
  return (
    <div className="space-y-4" data-testid="music-services">
      <p className="text-[0.86rem] text-muted">
        Pick a service to add it to Music Assistant. Its music then plays on every speaker, and its
        playlists show on the Media page.
      </p>
      <label className="flex items-center gap-2 rounded-lg border border-line-strong px-3">
        <Search className="h-4 w-4 text-muted" aria-hidden />
        <input
          className="min-h-11 flex-1 bg-transparent text-[0.9rem] text-ink focus:outline-none"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a service"
          aria-label="Find a service"
        />
      </label>
      {KINDS.map(({ kind, title }) => {
        const list = shown.filter((s) => s.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind}>
            <h4 className="mb-2 text-[0.8rem] tracking-wide text-faint uppercase">{title}</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {list.map((s) => {
                const done = s.added && !s.more;
                return (
                  <button
                    key={s.domain}
                    type="button"
                    disabled={done}
                    onClick={() => (s.domain === "ytmusic" ? onYoutube() : setPicked(s))}
                    className="flex min-h-14 items-center gap-3 rounded-lg border border-line-strong px-3 py-2 text-left hover:border-gold disabled:opacity-60"
                    data-testid="music-service"
                    data-domain={s.domain}
                  >
                    <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-gold/15 text-[0.8rem] font-semibold text-gold">
                      {s.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[0.9rem] text-ink">
                        {s.name}
                        {s.beta && <span className="ml-1 text-[0.72rem] text-faint">beta</span>}
                      </span>
                      <span className="block truncate text-[0.76rem] text-muted">
                        {s.added ? (
                          <span className="inline-flex items-center gap-1 text-ok">
                            <Check className="h-3 w-3" /> Added{s.more ? " · add another" : ""}
                          </span>
                        ) : (
                          (s.description ?? "")
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {!shown.length && <p className="text-[0.86rem] text-muted">Nothing called that.</p>}
    </div>
  );
}

/** One service's setup, Music Assistant's steps shown in turn. */
function ServiceSetup({
  service,
  onBack,
  onDone,
}: {
  service: Service;
  onBack: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>();
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);

  const show = (s: Step) => {
    setStep(s);
    setValues(
      Object.fromEntries(
        s.fields
          .filter((f) => f.value !== undefined && f.type !== "note")
          .map((f) => [f.key, f.value!]),
      ),
    );
  };
  const call = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    post(body)
      .then(show)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    let live = true;
    post({ action: "start", domain: service.domain })
      .then((s) => live && show(s))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [service.domain]);

  // A sign-in page or Music Assistant working: ask where it is now and then.
  const flowId = step?.flowId;
  const waiting = step?.type === "external" || step?.type === "progress";
  useEffect(() => {
    if (!waiting || !flowId) return;
    const t = window.setInterval(() => {
      post({ action: "get", flowId })
        .then((s) => {
          if (s.type !== step?.type || s.stepId !== step?.stepId) show(s);
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(t);
  }, [waiting, flowId, step?.type, step?.stepId]);

  // Leaving before it finished: Music Assistant stops the setup.
  useEffect(
    () => () => {
      if (flowId && step?.type !== "finish" && step?.type !== "abort")
        void post({ action: "abort", flowId }).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flowId],
  );

  return (
    <div className="space-y-3" data-testid="music-service-setup">
      <p className="text-[0.95rem] text-ink">{service.name}</p>
      {error && (
        <p className="text-[0.86rem] text-amber" role="alert">
          {error}
        </p>
      )}
      {!step && busy && <p className="text-[0.86rem] text-muted">Starting…</p>}
      {step?.type === "form" && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            call({ action: "submit", flowId: step.flowId, values });
          }}
        >
          {step.fields.map((f) =>
            f.type === "note" ? (
              <p key={f.key} className="text-[0.84rem] text-muted">
                {f.label}
                {f.description ? ` ${f.description}` : ""}
              </p>
            ) : f.type === "boolean" ? (
              <label
                key={f.key}
                className="flex min-h-11 items-center gap-2 text-[0.88rem] text-ink"
              >
                <input
                  type="checkbox"
                  checked={Boolean(values[f.key])}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
                />
                {f.label}
              </label>
            ) : (
              <label key={f.key} className="block text-[0.84rem] text-muted">
                {f.label}
                {f.required ? "" : " (if you want)"}
                {f.type === "choice" ? (
                  <select
                    className={input}
                    value={String(values[f.key] ?? "")}
                    required={f.required}
                    onChange={(e) => {
                      const o = f.options?.find((x) => String(x.value) === e.target.value);
                      setValues((v) => ({ ...v, [f.key]: o?.value ?? e.target.value }));
                    }}
                  >
                    {!f.required && <option value="">-</option>}
                    {f.options?.map((o) => (
                      <option key={String(o.value)} value={String(o.value)}>
                        {o.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={input}
                    type={
                      f.type === "secret" ? "password" : f.type === "number" ? "number" : "text"
                    }
                    autoComplete={f.type === "secret" ? "new-password" : "off"}
                    value={String(values[f.key] ?? "")}
                    required={f.required}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
                      }))
                    }
                    data-testid={`music-field-${f.key}`}
                  />
                )}
                {f.description && (
                  <span className="mt-1 block text-[0.76rem] text-faint">{f.description}</span>
                )}
                {step.errors[f.key] && (
                  <span className="mt-1 block text-[0.78rem] text-amber">{step.errors[f.key]}</span>
                )}
              </label>
            ),
          )}
          {step.errors.base && (
            <p className="text-[0.84rem] text-amber" role="alert">
              {step.errors.base}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" tone="primary" disabled={busy} data-testid="music-service-next">
              {busy ? "Checking…" : "Next"}
            </Button>
            <Button onClick={onBack}>Back</Button>
          </div>
        </form>
      )}
      {step?.type === "external" && step.url && (
        <div className="space-y-3">
          <p className="text-[0.9rem] text-ink">
            Sign in to {service.name} on its own page. Hearth carries on by itself when you have.
          </p>
          <a
            href={step.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-gold px-4 text-[0.9rem] text-bg"
            data-testid="music-service-signin"
          >
            Open {service.name}&apos;s sign-in <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      )}
      {step?.type === "progress" && (
        <p className="text-[0.9rem] text-muted" role="status">
          {step.text ?? "Music Assistant is working on it…"}
        </p>
      )}
      {step?.type === "finish" && (
        <div className="space-y-3" data-testid="music-service-done">
          <p className="flex items-center gap-2 text-[0.95rem] text-ink">
            <Check className="h-4 w-4 text-ok" /> {service.name} is added. Its music shows on the
            Media page once Music Assistant has read it (a few minutes the first time).
          </p>
          <div className="flex gap-2">
            <Button tone="primary" onClick={onDone}>
              Done
            </Button>
            <Button onClick={onBack}>Add another</Button>
          </div>
        </div>
      )}
      {step?.type === "abort" && (
        <div className="space-y-3">
          <p className="text-[0.9rem] text-amber" role="alert">
            {service.name} wasn&apos;t added
            {step.reason ? `: ${step.reason.toLowerCase()}` : ""}.
          </p>
          <Button onClick={onBack}>Back</Button>
        </div>
      )}
    </div>
  );
}
