import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  PanelLeft,
  Pencil,
  RefreshCw,
  Settings,
  Upload
} from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { CloudflareConnect } from "@/components/cloudflare-connect";
import { AddReport } from "@/components/add-report";
import { PublicationRow } from "@/components/publication-row";
import { PreviewDialog } from "@/components/preview-dialog";
import { EditorSheet } from "@/components/editor/editor-sheet";
import {
  useAutoSync,
  useBuildReport,
  usePublishSnapshot,
  useReports,
  useStatus
} from "@/hooks/use-pagecast";
import {
  PAGECAST_ACTIVITY_EVENT,
  type ActivityEventDetail,
  type ActivityStatus
} from "@/lib/activity";
import { cn } from "@/lib/utils";
import { copyToClipboard, relativeTime } from "@/lib/format";
import type { CloudflareStatus, Report } from "@/lib/types";

type ActiveView = "pages" | "settings";

interface ActivityItem extends ActivityEventDetail {
  id: string;
  createdAt: string;
}

interface PublishSummary {
  elapsedMs: number;
  url: string;
}

const publishStages = ["Preparing", "Uploading", "Publishing", "Finalizing"];

function formatElapsed(ms: number) {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function displayAccountName(cloudflare: CloudflareStatus | undefined) {
  const name = cloudflare?.accountName || "";
  if (name.trim() && !/^\(?redacted\)?$/i.test(name.trim())) {
    return name;
  }
  return cloudflare?.loggedIn || cloudflare?.accountId ? "Cloudflare account" : "";
}

function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 150);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return startedAt ? now - startedAt : 0;
}

export function App() {
  const status = useStatus();
  const reports = useReports();
  const publish = usePublishSnapshot();
  const autoSync = useAutoSync();
  const build = useBuildReport();

  const reportItems = useMemo(() => reports.data ?? [], [reports.data]);
  const [activeView, setActiveView] = useState<ActiveView>("pages");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [previewReport, setPreviewReport] = useState<Report | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editorReport, setEditorReport] = useState<Report | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [publishingReportId, setPublishingReportId] = useState<string | null>(null);
  const [publishStartedAt, setPublishStartedAt] = useState<number | null>(null);
  const [publishSummary, setPublishSummary] = useState<PublishSummary | null>(null);
  const elapsedMs = useElapsed(publishStartedAt);

  useEffect(() => {
    if (reports.isLoading) return;
    if (reportItems.length === 0) {
      setSelectedReportId(null);
      return;
    }
    if (!selectedReportId || !reportItems.some((report) => report.id === selectedReportId)) {
      setSelectedReportId(reportItems[0].id);
    }
  }, [reportItems, reports.isLoading, selectedReportId]);

  useEffect(() => {
    const onActivity = (event: Event) => {
      const detail = (event as CustomEvent<ActivityEventDetail>).detail;
      if (!detail?.title) return;
      setActivities((current) => [
        {
          ...detail,
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          createdAt: new Date().toISOString()
        },
        ...current
      ].slice(0, 8));
    };

    window.addEventListener(PAGECAST_ACTIVITY_EVENT, onActivity);
    return () => window.removeEventListener(PAGECAST_ACTIVITY_EVENT, onActivity);
  }, []);

  const selectedReport =
    reportItems.find((report) => report.id === selectedReportId) ?? null;

  const openPreview = (report: Report) => {
    setPreviewReport(report);
    setPreviewOpen(true);
  };

  const openEditor = (report: Report) => {
    setEditorReport(report);
    setEditorOpen(true);
  };

  const selectReport = (report: Report) => {
    setSelectedReportId(report.id);
    setActiveView("pages");
    setPublishSummary(null);
  };

  const startPublish = (report: Report) => {
    const startedAt = Date.now();
    setPublishingReportId(report.id);
    setPublishStartedAt(startedAt);
    setPublishSummary(null);
    publish.mutate(report.id, {
      onSuccess: (data) => {
        const elapsed = Date.now() - startedAt;
        setPublishSummary({
          elapsedMs: elapsed,
          url: data.publication.publicUrl || data.publication.localUrl || ""
        });
        setPublishStartedAt(null);
        setPublishingReportId(null);
      },
      onError: () => {
        setPublishStartedAt(null);
        setPublishingReportId(null);
      }
    });
  };

  const cloudflare = status.data?.cloudflare;
  const accountName = displayAccountName(cloudflare);
  const projectName = cloudflare?.projectName || "";
  const connected = Boolean(cloudflare?.loggedIn && accountName && projectName);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-background">
        <TopBar
          connected={connected}
          accountName={accountName}
          projectName={projectName}
          isRefreshing={status.isFetching || reports.isFetching}
          onRefresh={() => {
            void status.refetch();
            void reports.refetch();
          }}
        />

        {status.isError ? (
          <div className="border-b bg-destructive/5 px-4 py-3 text-sm text-destructive">
            We can't reach Pagecast on your machine. Start it with{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
              npm start
            </code>{" "}
            or{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">
              npx pagecast
            </code>
            .
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          <PageSidebar
            reports={reportItems}
            selectedReportId={selectedReportId}
            activeView={activeView}
            isLoading={reports.isLoading}
            onSelectReport={selectReport}
            onOpenSettings={() => setActiveView("settings")}
          />

          <main className="min-w-0 bg-muted/20">
            <AnimatePresence mode="wait">
              {activeView === "settings" ? (
                <motion.div
                  key="settings"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8"
                >
                  <SettingsView
                    cloudflare={cloudflare}
                    activities={activities}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key={selectedReport?.id || "pages"}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8"
                >
                  <PageWorkspace
                    report={selectedReport}
                    isLoading={reports.isLoading}
                    publishPending={publish.isPending}
                    buildPending={build.isPending}
                    publishingReportId={publishingReportId}
                    publishElapsedMs={elapsedMs}
                    publishSummary={publishSummary}
                    activities={activities}
                    autoSyncPending={autoSync.isPending}
                    onBuild={(report) => build.mutate(report.id)}
                    onToggleAutoSync={(report, enabled) =>
                      autoSync.mutate({ id: report.id, enabled })
                    }
                    onPreview={openPreview}
                    onEdit={openEditor}
                    onPublish={startPublish}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </main>
        </div>
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

function TopBar({
  connected,
  accountName,
  projectName,
  isRefreshing,
  onRefresh
}: {
  connected: boolean;
  accountName: string;
  projectName: string;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
      <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-[13px] font-semibold text-primary-foreground shadow-sm">
            P
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold tracking-tight">
                Pagecast
              </h1>
              <Badge variant={connected ? "secondary" : "outline"} className="hidden sm:inline-flex">
                {connected ? "Connected" : "Not connected"}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {connected
                ? `${accountName} / ${projectName}`
                : "Share pages without setting up hosting"}
            </p>
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={onRefresh}
          aria-label="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
        </Button>
      </div>
    </header>
  );
}

function PageSidebar({
  reports,
  selectedReportId,
  activeView,
  isLoading,
  onSelectReport,
  onOpenSettings
}: {
  reports: Report[];
  selectedReportId: string | null;
  activeView: ActiveView;
  isLoading: boolean;
  onSelectReport: (report: Report) => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="border-b bg-background lg:border-b-0 lg:border-r">
      <div className="flex h-full flex-col">
        <div className="border-b p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PanelLeft className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Pages</h2>
            </div>
            <Badge variant="muted">{reports.length}</Badge>
          </div>
          <AddReport />
        </div>

        <nav className="max-h-64 min-h-0 flex-1 space-y-1 overflow-y-auto p-2 lg:max-h-none" aria-label="Pages">
          {isLoading ? (
            <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading pages...
            </div>
          ) : reports.length === 0 ? (
            <div className="mx-2 my-6 rounded-lg border border-dashed px-3 py-6 text-center">
              <FileText className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No pages yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add an HTML or Markdown file to start.
              </p>
            </div>
          ) : (
            reports.map((report) => (
              <button
                key={report.id}
                type="button"
                onClick={() => onSelectReport(report)}
                className={cn(
                  "group relative flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  activeView === "pages" &&
                    selectedReportId === report.id &&
                    "bg-accent"
                )}
              >
                {activeView === "pages" && selectedReportId === report.id ? (
                  <motion.span
                    layoutId="selected-page-pill"
                    className="absolute left-0 top-2 h-8 w-0.5 rounded-full bg-primary"
                  />
                ) : null}
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {report.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    {report.publicUrl ? "Published" : "Draft"}
                    {report.kind === "upload" ? (
                      <span className="inline-flex items-center gap-1">
                        <Upload className="h-3 w-3" />
                        upload
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            ))
          )}
        </nav>

        <div className="border-t p-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              activeView === "settings" && "bg-accent font-medium"
            )}
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
            Settings
          </button>
        </div>
      </div>
    </aside>
  );
}

function PageWorkspace({
  report,
  isLoading,
  publishPending,
  buildPending,
  publishingReportId,
  publishElapsedMs,
  publishSummary,
  activities,
  autoSyncPending,
  onBuild,
  onToggleAutoSync,
  onPreview,
  onEdit,
  onPublish
}: {
  report: Report | null;
  isLoading: boolean;
  publishPending: boolean;
  buildPending: boolean;
  publishingReportId: string | null;
  publishElapsedMs: number;
  publishSummary: PublishSummary | null;
  activities: ActivityItem[];
  autoSyncPending: boolean;
  onBuild: (report: Report) => void;
  onToggleAutoSync: (report: Report, enabled: boolean) => void;
  onPreview: (report: Report) => void;
  onEdit: (report: Report) => void;
  onPublish: (report: Report) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-lg border bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading workspace...
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-dashed bg-background px-6 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <h2 className="mt-4 text-base font-semibold">Add your first page</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Use the sidebar to add a local HTML or Markdown file.
        </p>
      </div>
    );
  }

  const activePublications = report.publications.filter((publication) => publication.active);
  const latestSnapshot = [...activePublications]
    .reverse()
    .find((publication) => publication.kind === "snapshot" && publication.publicUrl);
  const isPublishingThisReport = publishPending && publishingReportId === report.id;
  const needsBuild = report.kind === "folder" && report.buildCommand && report.buildStatus !== "ready";

  return (
    <>
      <section className="rounded-lg border bg-background">
        <div className="flex flex-col gap-4 border-b p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold tracking-tight">
                {report.name}
              </h2>
              <Badge variant={report.publicUrl ? "secondary" : "outline"}>
                {report.publicUrl ? "Published" : "Draft"}
              </Badge>
              {report.kind === "upload" ? (
                <Badge variant="muted" className="gap-1">
                  <Upload className="h-3 w-3" />
                  upload
                </Badge>
              ) : null}
              {report.kind === "folder" ? (
                <Badge variant="muted" className="gap-1">
                  <FileText className="h-3 w-3" />
                  mini app
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {report.sourcePath || "Stored in Pagecast"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onPreview(report)}>
              <ExternalLink className="h-4 w-4" />
              Preview
            </Button>
            <Button variant="outline" size="sm" onClick={() => onEdit(report)}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
            {report.kind === "folder" && report.buildCommand ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onBuild(report)}
                disabled={buildPending}
              >
                {buildPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Build
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => onPublish(report)}
              disabled={publishPending || buildPending}
            >
              {isPublishingThisReport ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cloud className="h-4 w-4" />
              )}
              Publish URL
            </Button>
          </div>
        </div>

        <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <UrlRow
                label="Preview URL"
                value={report.localUrl}
                icon={ExternalLink}
              />
              <UrlRow
                label="Published URL"
                value={latestSnapshot?.publicUrl || report.publicUrl}
                icon={Link2}
                empty="Not published"
              />
            </div>

            {report.kind === "path" ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-3">
                <div>
                  <p className="text-sm font-medium">Auto-sync</p>
                  <p className="text-xs text-muted-foreground">
                    {report.autoSync
                      ? "Every source save republishes active snapshots."
                      : "Cloudflare publishes only when you choose."}
                  </p>
                </div>
                <Switch
                  checked={report.autoSync}
                  disabled={autoSyncPending}
                  onCheckedChange={(enabled) => onToggleAutoSync(report, enabled)}
                  aria-label="Toggle auto-sync"
                />
              </div>
            ) : null}

            {report.kind === "folder" ? (
              <div className="rounded-lg border bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Mini-app build</p>
                    <p className="text-xs text-muted-foreground">
                      {report.buildCommand
                        ? report.buildCommand
                        : "Static folder publishes as-is."}
                    </p>
                  </div>
                  <Badge
                    variant={
                      report.buildStatus === "failed"
                        ? "destructive"
                        : report.buildStatus === "ready"
                          ? "secondary"
                          : "muted"
                    }
                  >
                    {report.buildStatus}
                  </Badge>
                </div>
                {report.buildOutputDir ? (
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    output: {report.buildOutputDir}
                  </p>
                ) : null}
                {needsBuild ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Build this folder before previewing or publish will build it first.
                  </p>
                ) : null}
                {report.buildError ? (
                  <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">
                    {report.buildError}
                  </p>
                ) : null}
              </div>
            ) : null}

            <PublishProgress
              active={isPublishingThisReport}
              elapsedMs={publishElapsedMs}
              summary={publishSummary}
            />

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Published links</h3>
                <span className="text-xs text-muted-foreground">
                  {activePublications.length} active
                </span>
              </div>
              {activePublications.length > 0 ? (
                <div className="space-y-2">
                  {activePublications.map((publication) => (
                    <PublicationRow
                      key={publication.token}
                      publication={publication}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  No public links yet.
                </div>
              )}
            </section>
          </div>

          <ActivityPanel activities={activities} />
        </div>
      </section>
    </>
  );
}

function UrlRow({
  label,
  value,
  icon: Icon,
  empty = "Unavailable"
}: {
  label: string;
  value: string | null | undefined;
  icon: typeof Link2;
  empty?: string;
}) {
  const copy = async () => {
    if (!value) return;
    const ok = await copyToClipboard(value);
    toast[ok ? "success" : "error"](ok ? `${label} copied.` : `Could not copy ${label}.`);
  };

  const open = () => {
    if (!value) return;
    window.open(value, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-w-0 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      {value ? (
        <div className="mt-2 flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {value}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={copy}
            aria-label={`Copy ${label}`}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={open}
            aria-label={`Open ${label}`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <p className="mt-2 truncate text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function PublishProgress({
  active,
  elapsedMs,
  summary
}: {
  active: boolean;
  elapsedMs: number;
  summary: PublishSummary | null;
}) {
  if (!active && !summary) return null;
  const stageIndex = active
    ? Math.min(publishStages.length - 1, Math.floor(elapsedMs / 1400))
    : publishStages.length - 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border bg-background p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {active ? publishStages[stageIndex] : "Published"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {active
              ? `Working for ${formatElapsed(elapsedMs)}`
              : `Published in ${formatElapsed(summary?.elapsedMs ?? 0)}`}
          </p>
        </div>
        {active ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        )}
      </div>
      <div className="mt-4 grid grid-cols-4 gap-1">
        {publishStages.map((stage, index) => (
          <div key={stage} className="space-y-1">
            <div
              className={cn(
                "h-1 rounded-full bg-muted transition-colors",
                index <= stageIndex && "bg-sky-500"
              )}
            />
            <p className="truncate text-[10px] text-muted-foreground">{stage}</p>
          </div>
        ))}
      </div>
      {summary?.url ? (
        <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
          {summary.url}
        </p>
      ) : null}
    </motion.div>
  );
}

function ActivityPanel({ activities }: { activities: ActivityItem[] }) {
  return (
    <aside className="rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Activity</h3>
        </div>
      </div>
      <div className="max-h-[420px] space-y-2 overflow-y-auto p-3">
        {activities.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            No activity yet.
          </p>
        ) : (
          activities.map((item) => (
            <ActivityItemRow key={item.id} item={item} />
          ))
        )}
      </div>
    </aside>
  );
}

function ActivityItemRow({ item }: { item: ActivityItem }) {
  const Icon = activityIcon(item.status);
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", activityColor(item.status))} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs font-medium">{item.title}</p>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {relativeTime(item.createdAt)}
            </span>
          </div>
          {item.message ? (
            <p className="mt-1 break-words text-[11px] text-muted-foreground">
              {item.message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function activityIcon(status: ActivityStatus) {
  if (status === "error") return AlertCircle;
  if (status === "success") return CheckCircle2;
  return Activity;
}

function activityColor(status: ActivityStatus) {
  if (status === "error") return "text-destructive";
  if (status === "success") return "text-emerald-600";
  return "text-muted-foreground";
}

function SettingsView({
  cloudflare,
  activities
}: {
  cloudflare: CloudflareStatus | undefined;
  activities: ActivityItem[];
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="space-y-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Publishing account and project.
          </p>
        </div>
        <CloudflareConnect cloudflare={cloudflare} />
      </section>
      <ActivityPanel activities={activities} />
    </div>
  );
}
