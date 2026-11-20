import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JOB_DONE, type Job, type JobStepInput } from "@dragon-control/core";
import { api } from "./api";
import { useLiveQuery } from "../components/panels/lifecycle";

/** Jobs (Cave 2): plans of known operations, approved once, carried out step by step. */

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };
}

const live = (job: Job | undefined) => Boolean(job && !JOB_DONE.includes(job.status));

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("GET", "/api/jobs"),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "running") ? 2000 : 15_000),
  });
}

/** Where a PC's jobs are: this Hearth's own, or another PC's through the link. */
const jobsAt = (pc?: string) => (pc ? `/api/on/${encodeURIComponent(pc)}/jobs` : "/api/jobs");

export function useJob(id: string | undefined, pc?: string) {
  return useLiveQuery({
    queryKey: ["jobs", id, pc ?? ""],
    queryFn: () => api<Job>("GET", `${jobsAt(pc)}/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    // Progress fills in while it runs; a plan waiting for you is checked now and then.
    refetchInterval: (q) =>
      q.state.data?.status === "awaiting-approval"
        ? 15_000
        : live(q.state.data)
          ? 1500
          : false,
  });
}

export function usePlanJob() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({
      pc,
      ...body
    }: {
      title: string;
      reason?: string;
      steps: JobStepInput[];
      incidentId?: string;
      projectId?: string;
      /** Another PC: the plan is made and runs there. */
      pc?: string;
    }) => api<Job>("POST", jobsAt(pc), body),
    onSuccess: refresh,
  });
}

export function useJobDecision() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      fingerprint,
      pc,
    }: {
      id: string;
      decision: "approve" | "decline";
      /** The plan you were shown: approving anything else is refused. */
      fingerprint?: string;
      pc?: string;
    }) =>
      api<Job>("POST", `${jobsAt(pc)}/${encodeURIComponent(id)}/decision`, {
        decision,
        fingerprint,
      }),
    onSuccess: refresh,
  });
}

export function useStopJob() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api<Job>("POST", `/api/jobs/${encodeURIComponent(id)}/stop`, {}),
    onSuccess: refresh,
  });
}

/** Long work reported from your machines (voice training, big copies): progress and stalls. */
export function useLongWork() {
  return useQuery({
    queryKey: ["work"],
    queryFn: () => api<import("@dragon-control/core").TrackedWork[]>("GET", "/api/work"),
    refetchInterval: (q) =>
      q.state.data?.some((w) => w.status === "running" || w.status === "stalled") ? 15_000 : 60_000,
  });
}
