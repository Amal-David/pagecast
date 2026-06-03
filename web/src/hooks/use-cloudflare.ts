import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

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
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error) =>
      toast.error(message(error, "Could not connect to Cloudflare."))
  });
}

export function useCloudflareAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.cloudflareAccount(accountId),
    onSuccess: () => {
      toast.success("Cloudflare account connected.");
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error) =>
      toast.error(message(error, "Could not select account."))
  });
}
