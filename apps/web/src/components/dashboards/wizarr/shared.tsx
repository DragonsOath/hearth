import { ExternalLink } from "lucide-react";
import type { WizarrDashboard } from "@dragon-control/core";
import { useDashboard } from "../../../data/dashboards";
import { useWorkspace } from "../../../data/api";
import { keyPageHref } from "../../../lib/keyPage";

/** The Wizarr panel's data, read every 30 seconds (one read shared by its tabs). */
export function useWizarr(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: WizarrDashboard | undefined = q.data?.data?.app === "wizarr" ? q.data.data : undefined;
  // "Now" is when Wizarr was read, so rendering stays pure.
  const now = Date.parse(q.data?.at ?? "") || 0;
  return { q, d, now };
}

export const day = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

/** Access ending within a week, not already ended. */
export const endingSoon = (expires: string | undefined, now: number) => {
  const t = expires ? Date.parse(expires) : NaN;
  return t > now && t - now < 7 * 86_400_000;
};

/**
 * A page of Wizarr's own web app, for what stays there: password resets, API keys, server setup,
 * and the settings the Wizard and Settings tabs do not cover yet.
 */
export function WizarrPage({
  serviceId,
  path,
  children,
  testId,
}: {
  serviceId: string;
  path: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const href = keyPageHref(service, path);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      className="inline-flex min-h-9 items-center gap-1.5 text-[0.8rem] text-gold underline-offset-2 hover:underline"
    >
      {children} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
    </a>
  );
}
