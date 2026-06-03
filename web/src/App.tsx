import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CloudflareConnect } from "@/components/cloudflare-connect";
import { AddReport } from "@/components/add-report";
import { ReportList } from "@/components/report-list";
import { PreviewDialog } from "@/components/preview-dialog";
import { EditorSheet } from "@/components/editor/editor-sheet";
import { useReports, useStatus } from "@/hooks/use-pagecast";
import type { Report } from "@/lib/types";

export function App() {
  const status = useStatus();
  const reports = useReports();

  const [previewReport, setPreviewReport] = useState<Report | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editorReport, setEditorReport] = useState<Report | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const openPreview = (report: Report) => {
    setPreviewReport(report);
    setPreviewOpen(true);
  };
  const openEditor = (report: Report) => {
    setEditorReport(report);
    setEditorOpen(true);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight">
                Pagecast
              </span>
              <span className="text-xs text-muted-foreground">
                local reports, durable links
              </span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => {
                void status.refetch();
                void reports.refetch();
              }}
              aria-label="Refresh"
            >
              <RotateCw
                className={
                  status.isFetching || reports.isFetching
                    ? "h-4 w-4 animate-spin"
                    : "h-4 w-4"
                }
              />
            </Button>
          </div>
        </header>

        <section className="border-b bg-muted/30">
          <div className="mx-auto max-w-3xl px-6 py-8">
            <h1 className="text-balance text-2xl font-semibold leading-[1.15] tracking-tight sm:text-3xl">
              Publish any HTML or Markdown — straight from Claude Code or Codex to
              the internet.
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              On your own free Cloudflare account. One command, a durable public
              link.
            </p>
          </div>
        </section>

        {status.isError ? (
          <div className="mx-auto max-w-3xl px-6 pt-6">
            <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Can’t reach the local Pagecast server. Start it with{" "}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
                npm start
              </code>{" "}
              (or <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">npx pagecast</code>) and refresh.
            </div>
          </div>
        ) : null}

        <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          <CloudflareConnect cloudflare={status.data?.cloudflare} />

          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Add a report</h2>
              <p className="text-xs text-muted-foreground">
                Point Pagecast at a local HTML or Markdown file, or a file:// URL.
              </p>
            </div>
            <AddReport />
          </section>

          <Separator />

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Reports</h2>
              {reports.data?.length ? (
                <span className="text-xs text-muted-foreground">
                  Drag to reorder
                </span>
              ) : null}
            </div>

            {reports.isLoading ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading reports…
              </div>
            ) : reports.isError ? (
              <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                Couldn’t load reports — is the local server running?
              </div>
            ) : (
              <ReportList
                reports={reports.data ?? []}
                onPreview={openPreview}
                onEdit={openEditor}
              />
            )}
          </section>
        </main>
      </div>

      <PreviewDialog
        report={previewReport}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
      <EditorSheet
        report={editorReport}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
      <Toaster />
    </TooltipProvider>
  );
}
