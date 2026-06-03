import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  PublishResponse,
  Report,
  ReportsResponse,
  StatusResponse
} from "@/lib/types";

const STATUS_KEY = ["status"] as const;
const REPORTS_KEY = ["reports"] as const;

export function useStatus() {
  return useQuery<StatusResponse>({
    queryKey: STATUS_KEY,
    queryFn: api.getStatus,
    // Connect/publish flows can change account + project state out of band.
    refetchInterval: 15_000
  });
}

export function useReports() {
  return useQuery<Report[]>({
    queryKey: REPORTS_KEY,
    queryFn: async () => (await api.getReports()).reports,
    refetchInterval: 15_000
  });
}

function invalidateReports(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return fallback;
}

export function useAddPath() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.addPath(path),
    onSuccess: (data) => {
      toast.success(`Added "${data.report.name}".`);
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not add report."))
  });
}

export function useDeleteReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteReport(id),
    onSuccess: () => {
      toast.success("Report deleted.");
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not delete report."))
  });
}

export function usePublishSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.publishSnapshot(id),
    onSuccess: (data: PublishResponse) => {
      toast.success("Snapshot published.", {
        description: data.publication.publicUrl ?? undefined
      });
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Publish failed."))
  });
}

export function useRevokeAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeAll(id),
    onSuccess: (data) => {
      toast.success(
        data.revokedCount === 1
          ? "Revoked 1 link."
          : `Revoked ${data.revokedCount} links.`
      );
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not revoke links."))
  });
}

export function useAutoSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setAutoSync(id, enabled),
    onSuccess: (data) => {
      toast.success(
        data.report.autoSync ? "Auto-sync on." : "Auto-sync off."
      );
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not toggle auto-sync."))
  });
}

export function useSyncPublication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.syncPublication(token),
    onSuccess: () => {
      toast.success("Published link synced.");
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Sync failed."))
  });
}

export function useRevokePublication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.revokePublication(token),
    onSuccess: () => {
      toast.success("Link revoked.");
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not revoke link."))
  });
}

export function useSaveContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, html }: { id: string; html: string }) =>
      api.saveContent(id, html),
    onSuccess: () => {
      toast.success("Saved. Live snapshots updated.");
      invalidateReports(queryClient);
    },
    onError: (error) => toast.error(errorMessage(error, "Could not save edits."))
  });
}

// Optimistic reorder: reflect the new order immediately, roll back on error.
export function useReorder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.reorder(ids),
    onMutate: async (ids: string[]) => {
      await queryClient.cancelQueries({ queryKey: REPORTS_KEY });
      const previous = queryClient.getQueryData<Report[]>(REPORTS_KEY);
      if (previous) {
        const byId = new Map(previous.map((report) => [report.id, report]));
        const next = ids
          .map((id) => byId.get(id))
          .filter((report): report is Report => Boolean(report));
        queryClient.setQueryData<Report[]>(REPORTS_KEY, next);
      }
      return { previous };
    },
    onError: (error, _ids, context) => {
      if (context?.previous) {
        queryClient.setQueryData(REPORTS_KEY, context.previous);
      }
      toast.error(errorMessage(error, "Could not save order."));
    },
    onSettled: () => invalidateReports(queryClient)
  });
}

// Optimistic slug rename: patch the matching publication in place. Surfaces the
// server's 400 (invalid) / 409 (taken) messages on failure.
export function useRenameSlug() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ token, slug }: { token: string; slug: string }) =>
      api.renameSlug(token, slug),
    onMutate: async ({ token, slug }: { token: string; slug: string }) => {
      await queryClient.cancelQueries({ queryKey: REPORTS_KEY });
      const previous = queryClient.getQueryData<Report[]>(REPORTS_KEY);
      if (previous) {
        const next = previous.map((report) => ({
          ...report,
          publications: report.publications.map((publication) =>
            publication.token === token
              ? { ...publication, slug }
              : publication
          )
        }));
        queryClient.setQueryData<Report[]>(REPORTS_KEY, next);
      }
      return { previous };
    },
    onSuccess: () => toast.success("Custom URL updated."),
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(REPORTS_KEY, context.previous);
      }
      // 400 invalid, 409 taken — surface the precise server message.
      toast.error(errorMessage(error, "Could not update custom URL."));
    },
    onSettled: () => invalidateReports(queryClient)
  });
}

export type ReportsResult = ReportsResponse;
