import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Report } from "@/lib/types";

interface PreviewDialogProps {
  report: Report | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PreviewDialog({
  report,
  open,
  onOpenChange
}: PreviewDialogProps) {
  if (!report) return null;
  const src = report.localUrl ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-0 p-0">
        <DialogHeader className="flex flex-row items-center justify-between gap-4 space-y-0 border-b px-6 py-4 text-left">
          <DialogTitle className="truncate pr-8">{report.name}</DialogTitle>
          {src ? (
            <Button asChild size="sm" variant="outline" className="mr-8 shrink-0">
              <a href={src} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                Open
              </a>
            </Button>
          ) : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-muted/20">
          {src ? (
            <iframe
              src={src}
              title={`Preview of ${report.name}`}
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Nothing to preview yet.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
