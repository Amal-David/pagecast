import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { emitActivity } from "@/lib/activity";

function message(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return fallback;
}

export function useCloudflareConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cloudflareConnect(),
    onSuccess: () => {
      emitActivity({ status: "success", title: "Cloudflare connected" });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error) => {
      const text = message(error, "Could not connect to Cloudflare.");
      toast.error(text);
      emitActivity({ status: "error", title: "Cloudflare connect failed", message: text });
    }
  });
}

export function useCloudflareAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.cloudflareAccount(accountId),
    onSuccess: () => {
      toast.success("Cloudflare account connected.");
      emitActivity({ status: "success", title: "Cloudflare account selected" });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error) => {
      const text = message(error, "Could not select account.");
      toast.error(text);
      emitActivity({ status: "error", title: "Account selection failed", message: text });
    }
  });
}

export function useCloudflareLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cloudflareLogout(),
    onSuccess: () => {
      toast.success("Cloudflare logged out.");
      emitActivity({ status: "success", title: "Cloudflare logged out" });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error) => {
      const text = message(error, "Could not log out.");
      toast.error(text);
      emitActivity({ status: "error", title: "Cloudflare logout failed", message: text });
    }
  });
}
