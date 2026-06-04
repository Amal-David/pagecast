import { Suspense, lazy, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSaveContent } from "@/hooks/use-pagecast";
import type { Report } from "@/lib/types";

// Code-split: the CodeMirror editor (and its language package) is only fetched
// when the user actually opens a report for editing.
const CodeMirrorHtml = lazy(() => import("@/components/editor/code-mirror-html"));

interface EditorSheetProps {
  report: Report | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditorSheet({ report, open, onOpenChange }: EditorSheetProps) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const save = useSaveContent();

  useEffect(() => {
    let cancelled = false;
    if (open && report) {
      setLoading(true);
      setLoadError(null);
      api
        .getContent(report.id)
        .then((data) => {
          if (!cancelled) setHtml(data.html);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setLoadError(
              error instanceof Error ? error.message : "We couldn’t load this page."
            );
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, report]);

  if (!report) return null;

  const handleSave = () => {
    save.mutate(
      { id: report.id, html },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <SheetHeader className="space-y-1 border-b px-6 py-4 text-left">
          <SheetTitle className="truncate">{report.name}</SheetTitle>
          <SheetDescription>
            Make a quick edit. Saving updates every published link in place — same
            URL, new content.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading content…
            </div>
          ) : loadError ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
              {loadError}
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading editor…
                </div>
              }
            >
              <CodeMirrorHtml value={html} onChange={setHtml} />
            </Suspense>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading || save.isPending}>
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save &amp; republish
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
