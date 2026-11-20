import { ExternalLink, ShieldCheck } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { useWorkspace } from "../../../data/api";
import { keyPageHref } from "../../../lib/keyPage";
import { Skeleton } from "../../ui";
import { useSeerrView, type UserRow } from "./data";

/**
 * Seerr's People: who can request, how many requests each made, and their request limits.
 * Permissions and limits are changed in Seerr itself (they decide who may approve and what), linked
 * here; their requests are on the Overview.
 */
export function SeerrPeople({ serviceId, name }: AppViewProps) {
  const q = useSeerrView<{ users: UserRow[] }>(serviceId, "users");
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const users = keyPageHref(service, "/users");
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s users.</p>;
  return (
    <section className="space-y-3" aria-label={`${name} people`}>
      <ul className="divide-y divide-line" data-testid="seerr-users">
        {q.data.users.map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
            data-testid="seerr-user"
          >
            <span className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 text-ink">
                {u.name}
                {u.admin && (
                  <ShieldCheck
                    strokeWidth={1.5}
                    className="h-3.5 w-3.5 text-gold"
                    aria-label="Admin"
                  />
                )}
              </span>
              <span className="block text-[0.76rem] text-faint">
                {u.account} account · {u.requests} request{u.requests === 1 ? "" : "s"}
              </span>
            </span>
            <span className="text-[0.76rem] text-muted">
              Movies: {u.movieLimit} · Shows: {u.tvLimit}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[0.76rem] text-faint">
        Permissions and request limits decide who may approve and how much, so they are changed in{" "}
        {name}.{" "}
        {users && (
          <a
            href={users}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
            data-testid="seerr-open-users"
          >
            Open {name}&apos;s users <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
