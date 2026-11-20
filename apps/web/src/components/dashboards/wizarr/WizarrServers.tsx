import { Server } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { Skeleton, cx } from "../../ui";
import { WizarrPage, useWizarr } from "./shared";

/**
 * Wizarr's Servers: the media servers it invites people to, whether it can reach them, what new
 * people may do there, and the libraries an invitation can be limited to. Changing a server, the
 * onboarding steps and branding happen in Wizarr's own settings, linked here.
 */
export function WizarrServers({ serviceId, name }: AppViewProps) {
  const { q, d } = useWizarr(serviceId);
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || q.data?.error || !d)
    return (
      <p className="text-[0.86rem] text-amber">
        {name} could not be read right now. The Overview tab says why.
      </p>
    );
  const unlinked = d.libraries.filter((l) => l.serverId === 0);
  return (
    <section className="space-y-3" aria-label={`${name} media servers`}>
      {d.servers.length === 0 && (
        <p className="text-[0.86rem] text-muted">
          Wizarr has no media server yet. Add one in Wizarr&apos;s settings.
        </p>
      )}
      {d.servers.map((s) => {
        const libs = d.libraries.filter((l) => l.serverId === s.id);
        const allows = [
          s.allowDownloads && "downloads",
          s.allowLiveTv && "live TV",
          s.allowMobileUploads && "mobile uploads",
        ].filter(Boolean);
        return (
          <article
            key={s.id}
            className="space-y-2 rounded-xl border border-line p-3"
            data-testid="wizarr-server"
            data-hearth-target={`server:${s.id}`}
          >
            <header className="flex flex-wrap items-center gap-2">
              <Server strokeWidth={1.5} className="h-4 w-4 text-faint" />
              <span className="text-ink">{s.name}</span>
              <span className="text-[0.76rem] text-faint capitalize">{s.type}</span>
              <span
                className={cx(
                  "fit-pill ml-auto rounded-full border px-2 py-0.5 text-[0.72rem]",
                  s.verified ? "border-live/40 text-live" : "border-amber/50 text-amber",
                )}
              >
                {s.verified ? "Connected" : "Not reachable"}
              </span>
            </header>
            {s.externalUrl && (
              <p className="text-[0.78rem] text-faint">
                People open it at{" "}
                <a
                  href={s.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted underline-offset-2 hover:underline"
                >
                  {s.externalUrl}
                </a>
              </p>
            )}
            <p className="text-[0.78rem] text-faint">
              New people may use: {allows.length ? allows.join(", ") : "nothing extra"} (each
              invitation can allow more).
            </p>
            <div>
              <p className="mb-1 text-[0.74rem] tracking-wide text-faint uppercase">Libraries</p>
              {libs.length ? (
                <ul className="flex flex-wrap gap-1.5" data-testid="wizarr-libraries">
                  {libs.map((l) => (
                    <li
                      key={l.id}
                      className={cx(
                        "rounded-full border px-2.5 py-0.5 text-[0.78rem]",
                        l.enabled ? "border-line-strong text-ink" : "border-line text-faint",
                      )}
                    >
                      {l.name}
                      {!l.enabled && " (off)"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[0.8rem] text-muted">
                  None linked yet: invitations to {s.name} give every library.
                </p>
              )}
            </div>
          </article>
        );
      })}
      {unlinked.length > 0 && (
        <div
          className="rounded-xl border border-amber/40 p-3 text-[0.82rem]"
          data-testid="wizarr-unlinked"
        >
          <p className="text-amber">
            Wizarr has {unlinked.length} librar{unlinked.length === 1 ? "y" : "ies"} not linked to a
            server ({unlinked.map((l) => l.name).join(", ")}).
          </p>
          <p className="mt-1 text-muted">
            Wizarr ignores those in an invitation&apos;s limit, so Hearth does not offer them. In
            Wizarr, edit the server and save it to scan its libraries.
          </p>
          <WizarrPage serviceId={serviceId} path="/settings/" testId="wizarr-open-servers">
            Open Wizarr&apos;s media servers
          </WizarrPage>
        </div>
      )}
      <p className="text-[0.76rem] text-faint">
        Adding or changing a server, the steps new people see, and Wizarr&apos;s look stay in
        Wizarr.{" "}
        <WizarrPage serviceId={serviceId} path="/settings/" testId="wizarr-open-settings">
          Open Wizarr&apos;s settings
        </WizarrPage>
      </p>
    </section>
  );
}
