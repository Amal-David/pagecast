import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OperationJournalEntry } from "@/lib/types";

export function OperationJournal({
  operations,
  retryingOperationId,
  onRetry
}: {
  operations: OperationJournalEntry[];
  retryingOperationId: string | null;
  onRetry: (operation: OperationJournalEntry) => void;
}) {
  if (operations.length === 0) return null;

  return (
    <section
      aria-live="polite"
      className="border-b border-destructive/20 bg-destructive/5 px-4 py-3"
    >
      <div className="mx-auto flex max-w-[1180px] flex-col gap-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-destructive">
                Operations need attention
              </p>
              <Badge variant="destructive">
                {operations.length} {operations.length === 1 ? "operation" : "operations"}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pagecast has unfinished work. Pending operations were interrupted;
              failed operations show the last error. Only operations with a safe,
              type-specific recovery path can be retried here.
            </p>
          </div>
        </div>

        <ul className="grid max-h-40 gap-2 overflow-y-auto">
          {operations.map((operation) => {
            const isRetrying = retryingOperationId === operation.id;
            const canRetry = operation.recovery.mode === "automatic";
            return (
              <li
                key={operation.id}
                className="flex flex-col gap-2 rounded-md border border-destructive/15 bg-background/80 px-3 py-2 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">
                    {operation.recovery.title}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <code className="truncate font-mono font-medium">
                      /{operation.slug}
                    </code>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {operation.type}
                    </Badge>
                    <span className="capitalize text-muted-foreground">
                      {operation.status}
                    </span>
                    <span className="text-muted-foreground">
                      {operation.attempts}{" "}
                      {operation.attempts === 1 ? "attempt" : "attempts"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {operation.recovery.summary}
                  </p>
                  {operation.error ? (
                    <p className="mt-1 break-words text-xs text-destructive">
                      {operation.error}
                    </p>
                  ) : null}
                  {operation.recovery.manualReason ? (
                    <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-400">
                      Manual action required: {operation.recovery.manualReason}
                    </p>
                  ) : null}
                </div>
                {canRetry ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={retryingOperationId !== null}
                    onClick={() => onRetry(operation)}
                    className="shrink-0"
                  >
                    {isRetrying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {isRetrying ? "Retrying…" : operation.recovery.action}
                  </Button>
                ) : (
                  <Badge variant="outline" className="shrink-0">
                    Manual
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
