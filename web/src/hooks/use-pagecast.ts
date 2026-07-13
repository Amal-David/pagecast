import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { activityMessage, emitActivity } from "@/lib/activity";
import type {
  CloudflareSyncResponse,
  DeploymentsResponse,
  OperationJournalEntry,
  PublishResponse,
  Report,
  ReportsResponse,
  StatusResponse
} from "@/lib/types";

const STATUS_KEY = ["status"] as const;
const REPORTS_KEY = ["reports"] as const;
const OPERATIONS_KEY = ["operations"] as const;
const DEPLOYMENTS_KEY = ["deployments"] as const;

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

export function useOperations() {
  return useQuery<OperationJournalEntry[]>({
    queryKey: OPERATIONS_KEY,
    queryFn: async () => (await api.getOperations()).operations,
    refetchInterval: 15_000
  });
}

function invalidateReports(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
}

function invalidateOperations(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: OPERATIONS_KEY });
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
      emitActivity({
        status: "success",
        title: "Page added",
        message: data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not add report.");
      toast.error(message);
      emitActivity({ status: "error", title: "Add page failed", message });
    }
  });
}

export function useAddFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.addFolder,
    onSuccess: (data) => {
      toast.success(`Added "${data.report.name}".`);
      emitActivity({
        status: "success",
        title: "Folder added",
        message: data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not add folder.");
      toast.error(message);
      emitActivity({ status: "error", title: "Add folder failed", message });
    }
  });
}

export function useUploadFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.uploadFile(file),
    onSuccess: (data) => {
      toast.success(`Uploaded "${data.report.name}".`);
      emitActivity({
        status: "success",
        title: "File uploaded",
        message: data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not upload file.");
      toast.error(message);
      emitActivity({ status: "error", title: "Upload failed", message });
    }
  });
}

export function useUploadFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => api.uploadFolder(files),
    onSuccess: (data) => {
      toast.success(`Uploaded "${data.report.name}".`);
      emitActivity({
        status: "success",
        title: "Folder uploaded",
        message: data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not upload folder.");
      toast.error(message);
      emitActivity({ status: "error", title: "Folder upload failed", message });
    }
  });
}

export function useBuildReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.buildReport(id),
    onSuccess: (data) => {
      toast.success(`Built "${data.report.name}".`);
      emitActivity({
        status: "success",
        title: "Build complete",
        message: data.report.buildOutputDir || data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Build failed.");
      toast.error(message);
      emitActivity({ status: "error", title: "Build failed", message });
    }
  });
}

export function useDeleteReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteReport(id),
    onSuccess: (data) => {
      if (data.cleanupPending) {
        const message =
          data.cleanupError || "Local source cleanup will retry when Pagecast restarts.";
        toast.warning("Report deleted; cleanup is pending.", { description: message });
        emitActivity({ status: "info", title: "Page deleted; cleanup pending", message });
      } else {
        toast.success("Report deleted.");
        emitActivity({ status: "success", title: "Page deleted" });
      }
      invalidateReports(queryClient);
      invalidateOperations(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not delete report.");
      toast.error(message);
      emitActivity({ status: "error", title: "Delete failed", message });
      invalidateOperations(queryClient);
    }
  });
}

export function usePublishSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, drop }: { id: string; drop?: boolean }) =>
      api.publishSnapshot(id, { drop }),
    onSuccess: (data: PublishResponse) => {
      toast.success("Page published.", {
        description: data.publication.publicUrl ?? undefined
      });
      emitActivity({
        status: "success",
        title: "Page published",
        message: data.publication.publicUrl ?? data.publication.slug
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Publish failed.");
      toast.error(message);
      emitActivity({ status: "error", title: "Publish failed", message });
    }
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
      emitActivity({
        status: "success",
        title: "Links revoked",
        message:
          data.revokedCount === 1
            ? "1 link taken offline."
            : `${data.revokedCount} links taken offline.`
      });
      invalidateReports(queryClient);
      invalidateOperations(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not revoke links.");
      toast.error(message);
      emitActivity({ status: "error", title: "Revoke failed", message });
      invalidateOperations(queryClient);
    }
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
      emitActivity({
        status: "success",
        title: data.report.autoSync ? "Auto-sync on" : "Auto-sync off",
        message: data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not toggle auto-sync.");
      toast.error(message);
      emitActivity({ status: "error", title: "Auto-sync failed", message });
    }
  });
}

export function usePasswordProtection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      enabled,
      password
    }: {
      id: string;
      enabled: boolean;
      password?: string;
    }) => api.setPasswordProtection(id, enabled, password),
    onSuccess: (data) => {
      toast.success(
        data.report.passwordProtected
          ? "Password protection on."
          : "Password protection off."
      );
      emitActivity({
        status: "success",
        title: data.report.passwordProtected
          ? "Password protection on"
          : "Password protection off",
        message: data.report.name
      });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not update password protection.");
      toast.error(message);
      emitActivity({
        status: "error",
        title: "Password protection failed",
        message
      });
    }
  });
}

export function useSyncPublication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.syncPublication(token),
    onSuccess: () => {
      toast.success("Published link synced.");
      emitActivity({ status: "success", title: "Published link synced" });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Sync failed.");
      toast.error(message);
      emitActivity({ status: "error", title: "Sync failed", message });
    }
  });
}

export function useAdoptPublicationTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.adoptPublicationTarget(token),
    onSuccess: () => {
      toast.success("Legacy link attached to the selected Pages project.");
      emitActivity({ status: "success", title: "Legacy link target recovered" });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not attach the legacy link.");
      toast.error(message);
      emitActivity({ status: "error", title: "Target recovery failed", message });
    }
  });
}

export function useSyncCloudflarePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (_options?: { automatic?: boolean }) => api.syncCloudflarePages(),
    onSuccess: (data: CloudflareSyncResponse, options) => {
      const failedCount = data.failed.length;
      const automatic = options?.automatic === true;
      if (failedCount > 0) {
        if (!automatic) {
          toast.message(
            `Imported ${data.importedCount} link(s). ${failedCount} could not be synced.`
          );
        }
      } else if (data.importedCount > 0) {
        if (!automatic) {
          toast.success(`Imported ${data.importedCount} published link(s).`);
        }
      } else if (!automatic) {
        toast.message("Published links are already synced.");
      }
      if (!automatic && data.warnings.length > 0) {
        toast.message(data.warnings[0]);
      }
      if (!automatic || data.importedCount > 0 || failedCount > 0) {
        emitActivity({
          status: failedCount > 0 ? "error" : "success",
          title: automatic ? "Cloudflare auto-sync" : "Published links synced",
          message: `Imported ${data.importedCount}, skipped ${data.skippedCount}`
        });
      }
      queryClient.setQueryData(REPORTS_KEY, data.reports);
      if (!automatic || data.importedCount > 0 || failedCount > 0) {
        void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      }
    },
    onError: (error, options) => {
      const message = errorMessage(error, "Could not sync published links.");
      if (options?.automatic !== true) {
        toast.error(message);
      }
      emitActivity({ status: "error", title: "Published sync failed", message });
    }
  });
}

export function useSetCloudflareSyncEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.setCloudflareSyncEnabled(enabled),
    onSuccess: (data) => {
      toast.success(
        data.config.cloudflareSyncEnabled
          ? "Cloudflare auto-sync on."
          : "Cloudflare auto-sync off."
      );
      emitActivity({
        status: "success",
        title: data.config.cloudflareSyncEnabled
          ? "Cloudflare auto-sync on"
          : "Cloudflare auto-sync off"
      });
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not update Cloudflare auto-sync.");
      toast.error(message);
      emitActivity({ status: "error", title: "Cloudflare auto-sync failed", message });
    }
  });
}

export function useRevokePublication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.revokePublication(token),
    onSuccess: () => {
      toast.success("Link revoked.");
      emitActivity({ status: "success", title: "Link taken offline" });
      invalidateReports(queryClient);
      invalidateOperations(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not revoke link.");
      toast.error(message);
      emitActivity({ status: "error", title: "Revoke failed", message });
      invalidateOperations(queryClient);
    }
  });
}

export function useRetryOperation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (operation: OperationJournalEntry) => api.retryOperation(operation.id),
    onSuccess: () => {
      toast.success("Operation recovered.");
      emitActivity({ status: "success", title: "Operation recovered" });
      invalidateReports(queryClient);
      invalidateOperations(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not recover this operation.");
      toast.error(message);
      emitActivity({ status: "error", title: "Operation retry failed", message });
      invalidateReports(queryClient);
      invalidateOperations(queryClient);
    }
  });
}

// Per-link expiry change. Returns the publish response shape (report +
// publication), so reports must be refreshed. Surfaces the server's 400
// (invalid duration) message verbatim.
export function useSetExpiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ token, expires }: { token: string; expires: string }) =>
      api.setExpiry(token, expires),
    onSuccess: () => {
      toast.success("Link expiry updated.");
      emitActivity({ status: "success", title: "Link expiry updated" });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not update link expiry.");
      toast.error(message);
      emitActivity({ status: "error", title: "Link expiry failed", message });
    }
  });
}

// App-level default link lifetime. The new default lives on the config in the
// status query, so that's what must be refreshed.
export function useSetDefaultExpiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => api.setDefaultExpiry(value),
    onSuccess: () => {
      toast.success("Default expiry updated.");
      emitActivity({ status: "success", title: "Default expiry updated" });
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not update default expiry.");
      toast.error(message);
      emitActivity({ status: "error", title: "Default expiry failed", message });
    }
  });
}

export function useSaveContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, html }: { id: string; html: string }) =>
      api.saveContent(id, html),
    onSuccess: () => {
      toast.success("Saved. Live snapshots updated.");
      emitActivity({ status: "success", title: "Saved and republished" });
      invalidateReports(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not save edits.");
      toast.error(message);
      emitActivity({ status: "error", title: "Save failed", message });
    }
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
      const message = errorMessage(error, "Could not save order.");
      toast.error(message);
      emitActivity({ status: "error", title: "Reorder failed", message });
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
    onSuccess: () => {
      toast.success("Custom URL updated.");
      emitActivity({ status: "success", title: "Custom URL updated" });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(REPORTS_KEY, context.previous);
      }
      // 400 invalid, 409 taken — surface the precise server message.
      const message = activityMessage(error, "Could not update custom URL.");
      toast.error(message);
      emitActivity({ status: "error", title: "Custom URL failed", message });
    },
    onSettled: () => invalidateReports(queryClient)
  });
}

export function useFeedbackSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: { accountId?: string; reactions?: boolean } = {}) =>
      api.feedbackSetup(options),
    onSuccess: (data) => {
      toast.success(data.feedback?.reactionsEnabled ? "Analytics and reactions enabled." : "Analytics enabled.");
      emitActivity({
        status: "success",
        title: "Analytics enabled",
        message: data.feedback?.url ?? undefined
      });
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not set up feedback.");
      toast.error(message);
      emitActivity({ status: "error", title: "Feedback setup failed", message });
    }
  });
}

// Cloudflare Pages deployment snapshots (the whole-site deploy history). Gated
// on a live Cloudflare connection so it never spawns wrangler when signed out.
export function useDeployments(enabled: boolean) {
  return useQuery<DeploymentsResponse>({
    queryKey: DEPLOYMENTS_KEY,
    queryFn: api.getDeployments,
    enabled,
    refetchInterval: 30_000
  });
}

function invalidateDeployments(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: DEPLOYMENTS_KEY });
}

// Delete is irreversible and the live flag is recomputed server-side, so we
// invalidate (re-list from Cloudflare) rather than optimistically drop a row.
export function useDeleteDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.deleteDeployment(id, force ?? false),
    onSuccess: () => {
      toast.success("Snapshot deleted.");
      emitActivity({ status: "success", title: "Deployment snapshot deleted" });
      invalidateDeployments(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not delete snapshot.");
      toast.error(message);
      emitActivity({ status: "error", title: "Snapshot delete failed", message });
    }
  });
}

export function usePruneDeployments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keep: number) => api.pruneDeployments(keep),
    onSuccess: (data) => {
      const failedCount = data.failed.length;
      if (failedCount > 0) {
        toast.message(
          `Removed ${data.pruned} snapshot(s). ${failedCount} couldn't be deleted.`
        );
      } else {
        toast.success(`Cleaned up ${data.pruned} old snapshot(s).`);
      }
      emitActivity({
        status: failedCount > 0 ? "error" : "success",
        title: "Old snapshots cleaned up",
        message: `Removed ${data.pruned}, kept ${data.kept} newest`
      });
      invalidateDeployments(queryClient);
    },
    onError: (error) => {
      const message = errorMessage(error, "Could not clean up snapshots.");
      toast.error(message);
      emitActivity({ status: "error", title: "Snapshot cleanup failed", message });
    }
  });
}

export function useFeedbackStats(slug: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["feedback-stats", slug],
    queryFn: () => api.feedbackStats(slug as string),
    enabled: Boolean(slug) && enabled,
    refetchInterval: 30_000
  });
}

export function useAnalyticsSummary(publicationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["analytics-summary", publicationId || "all"],
    queryFn: () => api.analyticsSummary(publicationId || undefined),
    enabled,
    refetchInterval: 30_000
  });
}

export function useAnalyticsEvents(publicationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["analytics-events", publicationId || "all"],
    queryFn: () => api.analyticsEvents({ publicationId: publicationId || undefined, limit: 50 }),
    enabled,
    refetchInterval: 30_000
  });
}

export type ReportsResult = ReportsResponse;
