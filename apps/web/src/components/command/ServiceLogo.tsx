import type { Service } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { openTarget } from "../../lib/format";
import { Monogram, cx } from "../ui";

type Openable = Pick<Service, "name" | "publicUrl" | "localUrl">;

/** Where a system's web UI opens: its reverse proxy address, or the host's, as you chose in Settings. */
export function useOpenTarget(service: Openable) {
  const via = useWorkspace().data?.webUiVia ?? "proxy";
  return openTarget(service, via);
}

/** A system's logo; clicking it opens the system's own web UI in a new tab. */
export function ServiceLogo({
  service,
  className,
}: {
  service: Openable & Pick<Service, "image">;
  className?: string;
}) {
  const target = useOpenTarget(service);
  const logo = <Monogram name={service.name} image={service.image} className={className} />;
  if (!target) return logo;
  return (
    <a
      href={target.href}
      target="_blank"
      rel="noreferrer"
      aria-label={target.label}
      title={target.label}
      className={cx(
        "shrink-0 rounded-full transition-shadow hover:ring-2 hover:ring-gold/60 focus-visible:ring-2 focus-visible:ring-gold",
      )}
      data-testid="service-logo-link"
    >
      {logo}
    </a>
  );
}
