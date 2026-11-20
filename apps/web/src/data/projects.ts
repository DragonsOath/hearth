import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectColor,
  ProjectDetail,
  ProjectIcon,
  ProjectLinkInput,
  ProjectPhase,
  ProjectSummary,
  ProjectTask,
  ProjectTaskStatus,
} from "@dragon-control/core";
import { api } from "./api";
import { useLiveQuery } from "../components/panels/lifecycle";

/** Projects (command center): long-running work built on the memory projects. */

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
  };
}

export function useProjects(opts: { all?: boolean } = {}) {
  return useQuery({
    queryKey: ["projects", opts.all ? "all" : "active"],
    queryFn: () => api<ProjectSummary[]>("GET", `/api/projects${opts.all ? "?all=1" : ""}`),
    refetchInterval: (q) => (q.state.data?.some((p) => p.runningJobs) ? 3000 : 20_000),
  });
}

export function useProject(id: string | undefined) {
  return useLiveQuery({
    queryKey: ["projects", "detail", id],
    queryFn: () => api<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.runningJobs ? 2000 : 15_000),
  });
}

export function useCreateProject() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: {
      name: string;
      summary?: string;
      phase?: ProjectPhase;
      icon?: ProjectIcon;
      color?: ProjectColor;
      related?: ProjectLinkInput[];
    }) => api<ProjectDetail>("POST", "/api/projects", body),
    onSuccess: refresh,
  });
}

export function useUpdateProject() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      name?: string;
      summary?: string;
      status?: "active" | "paused" | "done";
      phase?: ProjectPhase;
      icon?: ProjectIcon;
      color?: ProjectColor | null;
      related?: ProjectLinkInput[];
    }) => api<ProjectDetail>("PATCH", `/api/projects/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
}

export function useAddTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ projectId, title }: { projectId: string; title: string }) =>
      api<ProjectTask>("POST", `/api/projects/${encodeURIComponent(projectId)}/tasks`, { title }),
    onSuccess: refresh,
  });
}

export function useUpdateTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({
      projectId,
      taskId,
      ...patch
    }: {
      projectId: string;
      taskId: string;
      title?: string;
      status?: ProjectTaskStatus;
    }) =>
      api<ProjectTask>(
        "PATCH",
        `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
        patch,
      ),
    onSuccess: refresh,
  });
}
