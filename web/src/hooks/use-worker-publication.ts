import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WorkerMutationResult, WorkerOverview, WorkerOverviewSection } from "@/lib/types";

export const workerKeys = {
  publication: (token: string) => ["worker-publication", token] as const,
  overview: (token: string, section: WorkerOverviewSection) => [...workerKeys.publication(token), "overview", section] as const,
  audit: (token: string) => [...workerKeys.publication(token), "audit"] as const,
  deliveries: (token: string, webhookId: string) => [...workerKeys.publication(token), "deliveries", webhookId] as const,
  profile: ["status"] as const,
  reports: ["reports"] as const
};

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useWorkerOverview(token: string, section: WorkerOverviewSection | null) {
  return useQuery<WorkerOverview>({
    queryKey: workerKeys.overview(token, section || "versions"),
    queryFn: () => api.workerOverview(token, section!),
    enabled: Boolean(token && section),
    refetchOnWindowFocus: true,
    // Jobs and agent actions can update the selected publication out of band.
    // Keep the polling bounded to the active panel instead of polling all links.
    refetchInterval: 30_000
  });
}

export function useWorkerAudit(token: string) {
  return useInfiniteQuery({
    queryKey: workerKeys.audit(token),
    queryFn: ({ pageParam }) => api.workerAudit(token, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: Boolean(token),
    refetchOnWindowFocus: true
  });
}

export function useWorkerWebhookDeliveries(token: string, webhookId: string | null) {
  return useQuery({
    queryKey: workerKeys.deliveries(token, webhookId || ""),
    queryFn: () => api.workerWebhookDeliveries(token, webhookId!),
    enabled: Boolean(token && webhookId),
    refetchOnWindowFocus: true
  });
}

export function useWorkerAction<T>(
  token: string,
  action: (input: T) => Promise<WorkerMutationResult>,
  success: string | ((result: WorkerMutationResult) => string),
  options: { onCredential?: (credential: string) => void } = {}
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => {
      const result = await action(input);
      // One-time credentials never become mutation/query cache data.
      const credential = [result.credential, result.secret, result.invitation, result.token]
        .find((value): value is string => typeof value === "string") || "";
      if (credential) options.onCredential?.(credential);
      return typeof success === "function" ? success(result) : success;
    },
    gcTime: 0,
    onSuccess: (successMessage) => {
      toast.success(successMessage);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: workerKeys.publication(token) }),
        queryClient.invalidateQueries({ queryKey: workerKeys.profile }),
        queryClient.invalidateQueries({ queryKey: workerKeys.reports })
      ]);
    },
    onError: (error) => toast.error(message(error, "The Worker action could not be completed."))
  });
}

export function useWorkerConnectionAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.connectWorker,
    gcTime: 0,
    onSuccess: () => {
      toast.success("Worker connection saved.");
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: workerKeys.profile }),
        queryClient.invalidateQueries({ queryKey: workerKeys.reports })
      ]);
    },
    onError: (error) => toast.error(message(error, "Worker connection failed."))
  });
}

export function useWorkerHealthAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.checkWorkerHealth,
    gcTime: 0,
    onSuccess: () => {
      toast.success("Worker health verified.");
    },
    onError: (error) => toast.error(message(error, "Worker health check failed.")),
    // The local server persists both successful and failed checks. Refresh the
    // safe status projection either way so a stale green state is never shown.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workerKeys.profile });
    }
  });
}

export function useWorkerDisconnectAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.disconnectWorker,
    gcTime: 0,
    onSuccess: () => {
      toast.success("Worker disconnected.");
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: workerKeys.profile }),
        queryClient.invalidateQueries({ queryKey: workerKeys.reports })
      ]);
    },
    onError: (error) => toast.error(message(error, "Worker disconnect failed."))
  });
}
