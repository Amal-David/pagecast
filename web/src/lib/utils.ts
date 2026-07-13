import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { FeedbackConfig } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isAnalyticsEnabled(
  feedback: Pick<FeedbackConfig, "url" | "analyticsEnabled"> | null | undefined
) {
  return Boolean(feedback?.url && feedback.analyticsEnabled !== false);
}
