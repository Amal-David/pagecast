export type ActivityStatus = "success" | "error" | "info";

export interface ActivityEventDetail {
  status: ActivityStatus;
  title: string;
  message?: string;
}

export const PAGECAST_ACTIVITY_EVENT = "pagecast:activity";

export function emitActivity(detail: ActivityEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ActivityEventDetail>(PAGECAST_ACTIVITY_EVENT, { detail })
  );
}

export function activityMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}
