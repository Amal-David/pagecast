import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Check,
  CheckCircle2,
  Cloud,
  CloudDownload,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  Trash2,
  WifiOff,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { CloudflareConnect } from "@/components/cloudflare-connect";
import { DeployHistory } from "@/components/deploy-history";
import { FeedbackCard } from "@/components/feedback-card";
import { DefaultExpiryCard } from "@/components/default-expiry-card";
import { ActivityPanel, GlobalActivity } from "@/components/activity-panel";
import { AddReport } from "@/components/add-report";
import { PagecastHomeOnboarding } from "@/components/pagecast-home-onboarding";
import { PublicationRow } from "@/components/publication-row";
import { OperationJournal } from "@/components/operation-journal";
import { PreviewDialog } from "@/components/preview-dialog";
import { EditorSheet } from "@/components/editor/editor-sheet";
import {
  useAutoSync,
  useBuildReport,
  useDeleteReport,
  usePasswordProtection,
  usePublishSnapshot,
  useOperations,
  useReports,
  useRevokeAll,
  useRetryOperation,
  useSetCloudflareSyncEnabled,
  useSyncCloudflarePages,
  useStatus
} from "@/hooks/use-pagecast";
import {
  useCloudflareProject,
  useCloudflareProjects
} from "@/hooks/use-cloudflare";
import {
  PAGECAST_ACTIVITY_EVENT,
  type ActivityEventDetail,
  type ActivityStatus
} from "@/lib/activity";
import {
  cloudflareProjectDomain,
  cloudflareProjectValue,
  getCloudflareProjectSelection
} from "@/lib/cloudflare";
import { cn } from "@/lib/utils";
import { copyToClipboard, relativeTime } from "@/lib/format";
import type { CloudflareProject, CloudflareStatus, FeedbackConfig, Report } from "@/lib/types";

type ActiveView = "pages" | "activity" | "settings";
type SettingsSection = "publishing" | "deploy-history" | "link-defaults" | "analytics";

interface ActivityItem extends ActivityEventDetail {
  id: string;
  createdAt: string;
}

interface PublishSummary {
  elapsedMs: number;
  url: string;
  expiresAt: number | null;
}

interface CloudflareProjectPreviewState {
  project: CloudflareProject;
  status: "syncing" | "missing";
  message?: string;
}

const buildStatusLabels: Record<string, string> = {
  idle: "Not built",
  building: "Building…",
  ready: "Ready",
  failed: "Build failed"
};

const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Cloud;
}> = [
  { id: "publishing", label: "Publishing", icon: Cloud },
  { id: "deploy-history", label: "Deploy history", icon: RefreshCw },
  { id: "link-defaults", label: "Link defaults", icon: Link2 },
  { id: "analytics", label: "Analytics", icon: BarChart3 }
];

function settingsSectionId(section: SettingsSection) {
  return `settings-${section}`;
}

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

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function httpOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? stripTrailingSlash(url.origin)
      : "";
  } catch {
    return "";
  }
}

function reportMatchesProjectRoot(report: Report, project: CloudflareProject) {
  const projectBaseUrl = httpOrigin(project.baseUrl || "");
  if (!projectBaseUrl) return false;
  return report.publications.some((publication) =>
    publication.active &&
    publication.publicUrl &&
    httpOrigin(publication.publicUrl) === projectBaseUrl
  );
}

function newestActivePublication(report: Report) {
  return report.publications
    .filter((publication) => publication.active)
    .reduce<Report["publications"][number] | null>((latest, publication) => {
      if (!latest) return publication;
      return new Date(publication.updatedAt).getTime() > new Date(latest.updatedAt).getTime()
        ? publication
        : latest;
    }, null);
}

function publishedSortTime(report: Report) {
  const publication = newestActivePublication(report);
  if (!publication) return 0;
  const time = new Date(publication.updatedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function reportUpdatedSortTime(report: Report) {
  const time = new Date(report.updatedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareSidebarReports(a: Report, b: Report) {
  const publishedDiff = publishedSortTime(b) - publishedSortTime(a);
  if (publishedDiff !== 0) return publishedDiff;

  const activeDiff =
    Number(b.publications.some((publication) => publication.active)) -
    Number(a.publications.some((publication) => publication.active));
  if (activeDiff !== 0) return activeDiff;

  const updatedDiff = reportUpdatedSortTime(b) - reportUpdatedSortTime(a);
  if (updatedDiff !== 0) return updatedDiff;

  return a.name.localeCompare(b.name);
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
  const operations = useOperations();
  const publish = usePublishSnapshot();
  const autoSync = useAutoSync();
  const passwordProtection = usePasswordProtection();
  const build = useBuildReport();
  const deleteReport = useDeleteReport();
  const revokeAll = useRevokeAll();
  const retryOperation = useRetryOperation();
  const syncCloudflare = useSyncCloudflarePages();
  const setCloudflareSyncEnabled = useSetCloudflareSyncEnabled();

  const reportItems = useMemo(() => reports.data ?? [], [reports.data]);
  const [activeView, setActiveView] = useState<ActiveView>("pages");
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsSection>("publishing");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [previewReport, setPreviewReport] = useState<Report | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editorReport, setEditorReport] = useState<Report | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [publishingReportId, setPublishingReportId] = useState<string | null>(null);
  const [publishStartedAt, setPublishStartedAt] = useState<number | null>(null);
  const [publishSummary, setPublishSummary] = useState<PublishSummary | null>(null);
  const [cloudflareProjectPreview, setCloudflareProjectPreview] =
    useState<CloudflareProjectPreviewState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Report | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<Report | null>(null);
  const syncPendingRef = useRef(false);
  const elapsedMs = useElapsed(publishStartedAt);

  useEffect(() => {
    if (cloudflareProjectPreview) return;
    if (reports.isLoading) return;
    if (reportItems.length === 0) {
      setSelectedReportId(null);
      return;
    }
    if (!selectedReportId || !reportItems.some((report) => report.id === selectedReportId)) {
      setSelectedReportId([...reportItems].sort(compareSidebarReports)[0].id);
    }
  }, [cloudflareProjectPreview, reportItems, reports.isLoading, selectedReportId]);

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
    setCloudflareProjectPreview(null);
    setSelectedReportId(report.id);
    setActiveView("pages");
    setPublishSummary(null);
  };

  const syncSelectedCloudflareProject = (project: CloudflareProject) => {
    setSelectedReportId(null);
    setActiveView("pages");
    setPublishSummary(null);
    setCloudflareProjectPreview({ project, status: "syncing" });
    syncCloudflare.mutate({}, {
      onSuccess: (data) => {
        const projectRootReport =
          data.reports.find((report) => reportMatchesProjectRoot(report, project)) || null;
        const fallbackReport = data.imported[0] || null;
        const nextReport = projectRootReport || fallbackReport;
        if (nextReport) {
          setCloudflareProjectPreview(null);
          setSelectedReportId(nextReport.id);
          return;
        }
        setCloudflareProjectPreview({
          project,
          status: "missing",
          message: data.failed[0]?.error
        });
      },
      onError: () => {
        setCloudflareProjectPreview({
          project,
          status: "missing",
          message: "Could not sync this project."
        });
      }
    });
  };

  const startPublish = (report: Report, drop = false) => {
    const startedAt = Date.now();
    setPublishingReportId(report.id);
    setPublishStartedAt(startedAt);
    setPublishSummary(null);
    publish.mutate({ id: report.id, drop }, {
      onSuccess: (data) => {
        const elapsed = Date.now() - startedAt;
        setPublishSummary({
          elapsedMs: elapsed,
          url: data.publication.publicUrl || data.publication.localUrl || "",
          expiresAt: data.publication.expiresAt
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

  const openSettingsSection = (section: SettingsSection) => {
    setActiveView("settings");
    setActiveSettingsSection(section);
    window.requestAnimationFrame(() => {
      document.getElementById(settingsSectionId(section))?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  };

  const goToSettings = () => openSettingsSection("publishing");

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteReport.mutate(pendingDelete.id, {
      onSettled: () => setPendingDelete(null)
    });
  };

  const confirmRevokeAll = () => {
    if (!pendingRevoke) return;
    revokeAll.mutate(pendingRevoke.id, {
      onSettled: () => setPendingRevoke(null)
    });
  };

  const cloudflare = status.data?.cloudflare;
  const accountName = displayAccountName(cloudflare);
  const projectName = cloudflare?.projectName || "";
  const connected = Boolean(
    cloudflare?.loggedIn &&
      accountName &&
      projectName &&
      cloudflare.requiresAdoption !== true
  );
  const cloudflareReady = !status.isLoading && status.data !== undefined;
  const feedback = status.data?.config?.feedback ?? null;
  const feedbackEnabled = Boolean(
    feedback?.url && feedback.analyticsEnabled !== false
  );
  const cloudflareSyncEnabled = status.data?.config?.cloudflareSyncEnabled !== false;
  const showOnboarding =
    activeView === "pages" && !connected && reportItems.length === 0 && !reports.isLoading;

  useEffect(() => {
    syncPendingRef.current = syncCloudflare.isPending;
  }, [syncCloudflare.isPending]);

  useEffect(() => {
    if (!connected || !cloudflareSyncEnabled) {
      return;
    }
    const run = () => {
      if (!syncPendingRef.current) {
        syncCloudflare.mutate({ automatic: true });
      }
    };
    run();
    const timer = window.setInterval(run, 120_000);
    return () => window.clearInterval(timer);
  }, [cloudflareSyncEnabled, connected, projectName]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <TopBar
          connected={connected}
          accountName={accountName}
          projectName={projectName}
          isRefreshing={
            status.isFetching || reports.isFetching || operations.isFetching
          }
          syncPending={syncCloudflare.isPending}
          syncDisabled={!connected}
          onRefresh={() => {
            void status.refetch();
            void reports.refetch();
            void operations.refetch();
          }}
          onSync={() => syncCloudflare.mutate({})}
          onOpenActivity={() => setActiveView("activity")}
          onOpenSettings={goToSettings}
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

        <OperationJournal
          operations={operations.data ?? status.data?.operations ?? []}
          retryingOperationId={
            retryOperation.isPending ? retryOperation.variables?.id ?? null : null
          }
          onRetry={(operation) => retryOperation.mutate(operation)}
        />

        <div className={cn(
          "grid min-h-0 flex-1 grid-cols-1",
          !showOnboarding && "lg:grid-cols-[52px_320px_minmax(0,1fr)]"
        )}>
          {!showOnboarding ? (
            <>
          <AppRail activeView={activeView} onPages={() => setActiveView("pages")} onActivity={() => setActiveView("activity")} onSettings={goToSettings} />
              {activeView === "settings" ? (
                <SettingsSidebar
                  activeSection={activeSettingsSection}
                  onSelect={openSettingsSection}
                />
              ) : (
                <PageSidebar
              reports={reportItems}
              selectedReportId={selectedReportId}
              activeView={activeView}
              isLoading={reports.isLoading}
              cloudflare={cloudflare}
              cloudflareSyncPending={syncCloudflare.isPending}
              onCloudflareProjectSelected={syncSelectedCloudflareProject}
              onSelectReport={selectReport}
              onOpenSettings={() => setActiveView("settings")}
              onRequestDelete={setPendingDelete}
              onRequestRevokeAll={setPendingRevoke}
                />
              )}
            </>
          ) : null}

          <main className="min-w-0 overflow-hidden bg-muted/20">
            {activeView === "activity" ? (
              <GlobalActivity reports={reportItems} enabled={feedbackEnabled} />
            ) : activeView === "settings" ? (
                <motion.div
                  key="settings"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="h-full overflow-hidden"
                >
                  <SettingsView
                    reports={reportItems}
                    cloudflare={cloudflare}
                    connected={connected}
                    feedback={feedback}
                    analyticsEnabled={feedbackEnabled}
                    defaultExpiry={status.data?.config?.defaultExpiry}
                    cloudflareSyncEnabled={cloudflareSyncEnabled}
                    cloudflareSyncPending={setCloudflareSyncEnabled.isPending}
                    onToggleCloudflareSync={(enabled) =>
                      setCloudflareSyncEnabled.mutate(enabled)
                    }
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="pages"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 py-4 sm:px-5 lg:px-6"
                >
                  {showOnboarding ? (
                    <PagecastHomeOnboarding
                      suggestedProjectName={status.data?.home?.suggestedProjectName || "pagecast-home"}
                    />
                  ) : <PageWorkspace
                    report={selectedReport}
                    cloudflareProjectPreview={cloudflareProjectPreview}
                    isLoading={reports.isLoading}
                    connected={connected}
                    cloudflareReady={cloudflareReady}
                    publishPending={publish.isPending}
                    buildPending={build.isPending}
                    publishingReportId={publishingReportId}
                    publishElapsedMs={elapsedMs}
                    publishSummary={publishSummary}
                    feedbackEnabled={feedbackEnabled}
                    autoSyncPending={autoSync.isPending}
                    passwordProtectionPending={passwordProtection.isPending}
                    onBuild={(report) => build.mutate(report.id)}
                    onToggleAutoSync={(report, enabled) =>
                      autoSync.mutate({ id: report.id, enabled })
                    }
                    onDisablePassword={(report) =>
                      passwordProtection.mutate({ id: report.id, enabled: false })
                    }
                    onSetPassword={(report, password, onSuccess) =>
                      passwordProtection.mutate(
                        { id: report.id, enabled: true, password },
                        { onSuccess }
                      )
                    }
                    onPreview={openPreview}
                    onEdit={openEditor}
                    onPublish={startPublish}
                    onConnect={goToSettings}
                    onRequestDelete={setPendingDelete}
                    onRequestRevokeAll={setPendingRevoke}
                  />}
                </motion.div>
              )}
          </main>
        </div>
        <ActivityDock activities={activities} />
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

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this page?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be removed from Pagecast${
                    pendingDelete.publications.some((p) => p.active)
                      ? " and any public links it has will be taken offline"
                      : ""
                  }. Your original source file is not touched. This can't be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteReport.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete page
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take all links offline?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevoke
                ? `Every public link for "${pendingRevoke.name}" will stop working after the next deploy. The page itself stays in Pagecast — you can publish a fresh link anytime.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmRevokeAll();
              }}
            >
              {revokeAll.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Take links offline
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster />
    </TooltipProvider>
  );
}

function TopBar({
  connected,
  accountName,
  projectName,
  isRefreshing,
  syncPending,
  syncDisabled,
  onRefresh,
  onSync,
  onOpenActivity,
  onOpenSettings
}: {
  connected: boolean;
  accountName: string;
  projectName: string;
  isRefreshing: boolean;
  syncPending: boolean;
  syncDisabled: boolean;
  onRefresh: () => void;
  onSync: () => void;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="z-30 border-b bg-background/95 backdrop-blur">
      <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
              <circle cx="6.5" cy="17.5" r="2.5" fill="currentColor" />
              <path
                d="M6.5 11.5a6 6 0 0 1 6 6M6.5 5.5a12 12 0 0 1 12 12"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">
                Pagecast
              </h1>
              <Badge variant={connected ? "secondary" : "outline"} className="hidden gap-1 sm:inline-flex">
                {connected ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
                {connected ? "Connected" : "Not connected"}
              </Badge>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {connected
                ? `${accountName} / ${projectName}`
                : "Share pages without setting up hosting"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={onSync}
                disabled={syncDisabled || syncPending}
                aria-label="Sync published links from Cloudflare"
              >
                {syncPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CloudDownload className="h-4 w-4" />
                )}
                Sync
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {syncDisabled ? "Connect Cloudflare first" : "Sync published links from Cloudflare"}
            </TooltipContent>
          </Tooltip>
          <Button
            size="icon"
            variant="outline"
            className="h-9 w-9"
            onClick={onRefresh}
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenActivity}>
            <Activity className="h-4 w-4" />
            Activity
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenSettings}>
            <Settings className="h-4 w-4" />
            Settings
          </Button>
        </div>
      </div>
    </header>
  );
}

function AppRail({
  activeView,
  onPages,
  onActivity,
  onSettings
}: {
  activeView: ActiveView;
  onPages: () => void;
  onActivity: () => void;
  onSettings: () => void;
}) {
  return (
    <aside className="hidden border-r bg-background lg:flex lg:flex-col lg:items-center lg:justify-between lg:py-4">
      <div className="flex flex-col gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant={activeView === "pages" ? "secondary" : "ghost"}
              className="h-9 w-9"
              onClick={onPages}
              aria-label="Pages"
            >
              <FileText className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Pages</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant={activeView === "activity" ? "secondary" : "ghost"}
              className="h-9 w-9"
              onClick={onActivity}
              aria-label="Activity"
            >
              <Activity className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Activity</TooltipContent>
        </Tooltip>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant={activeView === "settings" ? "secondary" : "ghost"}
            className="h-9 w-9"
            onClick={onSettings}
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>
    </aside>
  );
}

function SettingsSidebar({
  activeSection,
  onSelect
}: {
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  return (
    <aside className="hidden min-h-0 border-r bg-background lg:block">
      <div className="border-b p-4">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Settings</h2>
        </div>
      </div>
      <nav className="space-y-1 p-2" aria-label="Settings sections">
        {settingsSections.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            onClick={() => onSelect(id)}
            aria-current={activeSection === id ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              activeSection === id ? "bg-accent font-medium" : "text-muted-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function PageSidebar({
  reports,
  selectedReportId,
  activeView,
  isLoading,
  cloudflare,
  cloudflareSyncPending,
  onCloudflareProjectSelected,
  onSelectReport,
  onOpenSettings,
  onRequestDelete,
  onRequestRevokeAll
}: {
  reports: Report[];
  selectedReportId: string | null;
  activeView: ActiveView;
  isLoading: boolean;
  cloudflare: CloudflareStatus | undefined;
  cloudflareSyncPending: boolean;
  onCloudflareProjectSelected: (project: CloudflareProject) => void;
  onSelectReport: (report: Report) => void;
  onOpenSettings: () => void;
  onRequestDelete: (report: Report) => void;
  onRequestRevokeAll: (report: Report) => void;
}) {
  const [items, setItems] = useState<Report[]>(reports);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "published" | "draft" | "mini" | "recovered">("all");

  useEffect(() => {
    setItems(reports);
  }, [reports]);

  const displayedItems = items.filter((report) => {
    const activeCount = report.publications.filter((publication) => publication.active).length;
    const matchesQuery = report.name.toLowerCase().includes(query.trim().toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "published" && activeCount > 0) ||
      (filter === "draft" && activeCount === 0) ||
      (filter === "mini" && report.kind === "folder") ||
      (filter === "recovered" && report.importedFromCloudflare);
    return matchesQuery && matchesFilter;
  }).sort(compareSidebarReports);

  return (
    <aside className="min-h-0 border-b bg-background lg:border-b-0 lg:border-r">
      <div className="flex h-full flex-col">
        <div className="border-b p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PanelLeft className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Pages</h2>
            </div>
            <Badge variant="muted">{reports.length}</Badge>
          </div>
          <div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 pl-8"
                placeholder="Search pages..."
                aria-label="Search pages"
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[
              ["all", "All"],
              ["published", "Live"],
              ["draft", "Draft"],
              ["mini", "Apps"],
              ["recovered", "Recovered"]
            ].map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? "secondary" : "outline"}
                className="h-7 rounded-full px-3 text-xs"
                onClick={() => setFilter(value as typeof filter)}
              >
                {label}
              </Button>
            ))}
          </div>
          <details className="mt-3">
            <summary className="flex cursor-pointer list-none items-center justify-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 hover:bg-emerald-100">
              <Plus className="h-3.5 w-3.5" />
              Add page
            </summary>
            <div className="mt-3">
              <AddReport />
            </div>
          </details>
        </div>

        <CloudflareProjectList
          cloudflare={cloudflare}
          syncPending={cloudflareSyncPending}
          onProjectSelected={onCloudflareProjectSelected}
        />

        <nav className="max-h-64 min-h-0 flex-1 space-y-1 overflow-y-auto p-2 lg:max-h-none" aria-label="Pages">
          {isLoading ? (
            <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading pages...
            </div>
          ) : displayedItems.length === 0 ? (
            <div className="mx-2 my-6 rounded-lg border border-dashed px-3 py-6 text-center">
              <FileText className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">
                {items.length === 0 ? "No pages yet" : "No matching pages"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {items.length === 0
                  ? "Add an HTML or Markdown file to start."
                  : "Try another search or filter."}
              </p>
            </div>
          ) : (
            displayedItems.map((report) => (
              <PageRow
                key={report.id}
                report={report}
                isSelected={
                  activeView === "pages" && selectedReportId === report.id
                }
                onSelect={onSelectReport}
                onRequestDelete={onRequestDelete}
                onRequestRevokeAll={onRequestRevokeAll}
              />
            ))
          )}
        </nav>

        <div className="border-t p-2 lg:hidden">
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

function CloudflareProjectList({
  cloudflare,
  syncPending,
  onProjectSelected
}: {
  cloudflare: CloudflareStatus | undefined;
  syncPending: boolean;
  onProjectSelected: (project: CloudflareProject) => void;
}) {
  const loggedIn = Boolean(cloudflare?.loggedIn);
  const projectsQuery = useCloudflareProjects(loggedIn);
  const selectProject = useCloudflareProject();
  const projects = projectsQuery.data?.cloudflare.projects ?? [];
  const projectName = cloudflare?.projectName ?? "";
  const selectedAccountId = cloudflare?.accountId || "";
  const requiresAdoption = cloudflare?.requiresAdoption === true;
  const { selectedProjectValue, displayedProjects } = getCloudflareProjectSelection(
    projects,
    projectName,
    selectedAccountId
  );

  if (!loggedIn) {
    return null;
  }

  return (
    <section className="border-b px-2 py-2" aria-label="Cloudflare Pages projects">
      <div className="mb-1.5 flex items-center justify-between px-2">
        <div className="flex min-w-0 items-center gap-2">
          <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <h3 className="truncate text-xs font-medium text-muted-foreground">Cloudflare Pages</h3>
        </div>
        <Badge variant="muted">{projectsQuery.isLoading ? "..." : projects.length}</Badge>
      </div>

      {projectsQuery.isLoading ? (
        <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading projects...
        </div>
      ) : displayedProjects.length === 0 ? (
        <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">
          No Pages projects found.
        </div>
      ) : (
        <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
          {displayedProjects.map((project) => {
            const projectValue = cloudflareProjectValue(project);
            const isCurrent = projectValue === selectedProjectValue;
            const canAdopt = isCurrent && requiresAdoption;

            return (
              <button
                key={projectValue}
                type="button"
                disabled={(isCurrent && !canAdopt) || selectProject.isPending || syncPending}
                onClick={() => selectProject.mutate(project, { onSuccess: () => onProjectSelected(project) })}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent",
                  isCurrent && "bg-emerald-50 text-emerald-950 ring-1 ring-emerald-100 disabled:hover:bg-emerald-50"
                )}
              >
                <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{project.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {cloudflareProjectDomain(project)}
                  </span>
                </span>
                {isCurrent && !canAdopt ? (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    Current
                  </Badge>
                ) : (
                  <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                    {canAdopt ? "Adopt" : "Switch"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PageRow({
  report,
  isSelected,
  onSelect,
  onRequestDelete,
  onRequestRevokeAll
}: {
  report: Report;
  isSelected: boolean;
  onSelect: (report: Report) => void;
  onRequestDelete: (report: Report) => void;
  onRequestRevokeAll: (report: Report) => void;
}) {
  const activeLinkCount = report.publications.filter((publication) => publication.active).length;
  const hasActiveLinks = activeLinkCount > 0;
  const stateLabel = hasActiveLinks ? "Live" : "Draft";
  const detailLabels = [
    report.sourceMissing ? "Source missing" : "",
    report.importedFromCloudflare ? "Recovered" : "",
    report.kind === "folder" ? "Mini app" : "",
    report.kind === "upload" ? "Upload" : "",
    report.passwordProtected ? "Protected" : ""
  ].filter(Boolean);
  const secondaryText = detailLabels.length > 0
    ? `${stateLabel} · ${detailLabels.join(" · ")}`
    : stateLabel;

  return (
    <div
      className={cn(
        "group relative mb-1 flex items-center rounded-md transition-colors hover:bg-accent",
        isSelected && "bg-emerald-50 ring-1 ring-emerald-100"
      )}
    >
      {isSelected ? (
        <motion.span
          layoutId="selected-page-pill"
          className="absolute left-0 top-2 h-8 w-0.5 rounded-full bg-emerald-600"
        />
      ) : null}
      <button
        type="button"
        onClick={() => onSelect(report)}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-2 pl-6 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{report.name}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{secondaryText}</span>
          </span>
        </span>
        {hasActiveLinks ? (
          <span className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <Link2 className="h-3 w-3" />
            {activeLinkCount}
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="mr-1 h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Actions for ${report.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {hasActiveLinks ? (
            <>
              <DropdownMenuItem onSelect={() => onRequestRevokeAll(report)}>
                <WifiOff className="h-4 w-4" />
                Take links offline
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            onSelect={() => onRequestDelete(report)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete page
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PageWorkspace({
  report,
  cloudflareProjectPreview,
  isLoading,
  connected,
  cloudflareReady,
  publishPending,
  buildPending,
  publishingReportId,
  publishElapsedMs,
  publishSummary,
  feedbackEnabled,
  autoSyncPending,
  passwordProtectionPending,
  onBuild,
  onToggleAutoSync,
  onDisablePassword,
  onSetPassword,
  onPreview,
  onEdit,
  onPublish,
  onConnect,
  onRequestDelete,
  onRequestRevokeAll
}: {
  report: Report | null;
  cloudflareProjectPreview: CloudflareProjectPreviewState | null;
  isLoading: boolean;
  connected: boolean;
  cloudflareReady: boolean;
  publishPending: boolean;
  buildPending: boolean;
  publishingReportId: string | null;
  publishElapsedMs: number;
  publishSummary: PublishSummary | null;
  feedbackEnabled: boolean;
  autoSyncPending: boolean;
  passwordProtectionPending: boolean;
  onBuild: (report: Report) => void;
  onToggleAutoSync: (report: Report, enabled: boolean) => void;
  onDisablePassword: (report: Report) => void;
  onSetPassword: (report: Report, password: string, onSuccess: () => void) => void;
  onPreview: (report: Report) => void;
  onEdit: (report: Report) => void;
  onPublish: (report: Report, drop: boolean) => void;
  onConnect: () => void;
  onRequestDelete: (report: Report) => void;
  onRequestRevokeAll: (report: Report) => void;
}) {
  const [passwordDraftOpen, setPasswordDraftOpen] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  // A drop is short and intentionally discoverable; the default is an unlisted
  // capability URL. Password protection remains the access-control boundary.
  const [publishAsDrop, setPublishAsDrop] = useState(false);

  const reportId = report?.id ?? null;
  const isProtected = report?.passwordProtected ?? false;

  // Collapse the draft whenever the selected report or its protection changes.
  // Also reset the publish-time choices: PageWorkspace is a single persistent
  // instance (not keyed by report id), so without this `publishAsDrop` would
  // leak across report switches and a later short-link publish could mark the
  // wrong report as a guessable drop.
  useEffect(() => {
    setPasswordDraftOpen(false);
    setPasswordDraft("");
    setPublishAsDrop(false);
  }, [reportId, isProtected]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading workspace...
      </div>
    );
  }

  if (!report) {
    if (cloudflareProjectPreview) {
      const projectUrl = cloudflareProjectPreview.project.baseUrl || "";
      const isSyncing = cloudflareProjectPreview.status === "syncing";

      return (
        <div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
            {isSyncing ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <h2 className="mt-4 text-base font-semibold">
            {isSyncing
              ? "Recovering project preview"
              : `No preview found for ${cloudflareProjectPreview.project.name}`}
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {isSyncing
              ? `Importing the live root from ${projectUrl || cloudflareProjectPreview.project.name}.`
              : cloudflareProjectPreview.message
                ? `Cloudflare reported: ${cloudflareProjectPreview.message}`
                : `Pagecast could not recover ${projectUrl || cloudflareProjectPreview.project.name}.`}
          </p>
          {projectUrl ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => window.open(projectUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="h-4 w-4" />
              Open project
            </Button>
          ) : null}
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
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
  const hasActiveLinks = activePublications.length > 0;
  // Only block publishing once we actually know Cloudflare is not connected;
  // while status is still loading we keep the button live to avoid a flash.
  const publishBlocked = cloudflareReady && !connected;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-muted/20">
      <div className="mx-auto flex min-h-full max-w-[1480px] flex-col gap-4 p-5">
        <PreviewPane
          report={report}
          publication={latestSnapshot || activePublications[0] || null}
          hasActiveLinks={hasActiveLinks}
          isPublishing={isPublishingThisReport}
          publishAsDrop={publishAsDrop}
          publishPending={publishPending}
          buildPending={buildPending}
          publishBlocked={publishBlocked}
          onConnect={onConnect}
          onEdit={onEdit}
          onPreview={onPreview}
          onPublish={onPublish}
          onRequestDelete={onRequestDelete}
          onRequestRevokeAll={onRequestRevokeAll}
        />

        <div className="space-y-4">
          {publishBlocked ? (
            <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-amber-900">
                  Connect a free Cloudflare account once to turn your pages into public links.
                </p>
              </div>
              <Button size="sm" onClick={onConnect} className="shrink-0">
                Connect Cloudflare
              </Button>
            </div>
          ) : null}

          <PublishProgress
            active={isPublishingThisReport}
            elapsedMs={publishElapsedMs}
            summary={publishSummary}
          />

          <section className="rounded-lg border bg-background">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Published links</h3>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {activePublications.length} {activePublications.length === 1 ? "link" : "links"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onPublish(report, publishAsDrop)}
                  disabled={publishBlocked || publishPending || buildPending}
                >
                  <Plus className="h-4 w-4" />
                  New link
                </Button>
              </div>
            </div>
            {activePublications.length > 0 ? (
              <div className="divide-y">
                {activePublications.map((publication) => (
                  <PublicationRow
                    key={publication.token}
                    publication={publication}
                    analyticsEnabled={feedbackEnabled}
                  />
                ))}
              </div>
            ) : (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No public links yet.
              </div>
            )}
          </section>

          {hasActiveLinks ? (
            <ActivityPanel
              publications={activePublications}
              enabled={feedbackEnabled}
            />
          ) : null}

          <section className="rounded-lg border bg-background">
            <div className="border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Settings</h3>
            </div>
            <div className="divide-y">
              {report.kind === "path" ? (
                <SettingsRow
                  label="Auto-sync"
                  value={report.autoSync ? "Source save" : "Manual"}
                  control={
                    <Switch
                      checked={report.autoSync}
                      disabled={autoSyncPending}
                      onCheckedChange={(enabled) => onToggleAutoSync(report, enabled)}
                      aria-label="Toggle page auto-sync"
                    />
                  }
                />
              ) : null}
              <SettingsRow
                label="Short public link"
                value={publishAsDrop ? "Easy to share" : "Unlisted capability"}
                control={
                  <Switch
                    checked={publishAsDrop}
                    onCheckedChange={setPublishAsDrop}
                    aria-label="Use a short public link"
                  />
                }
              />
              <SettingsRow
                label="Password protection"
                value={report.passwordProtected ? "On" : "Off"}
                control={
                  <Switch
                    checked={report.passwordProtected || passwordDraftOpen}
                    disabled={passwordProtectionPending}
                    onCheckedChange={(enabled) => {
                      if (enabled) {
                        setPasswordDraft("");
                        setPasswordDraftOpen(true);
                        return;
                      }
                      setPasswordDraftOpen(false);
                      onDisablePassword(report);
                    }}
                    aria-label="Toggle password protection"
                  />
                }
              />
              {passwordDraftOpen ? (
                <div className="flex items-center gap-2 px-4 py-3">
                  <Input
                    autoFocus
                    type="password"
                    value={passwordDraft}
                    onChange={(event) => setPasswordDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && passwordDraft.trim()) {
                        onSetPassword(report, passwordDraft.trim(), () => {
                          setPasswordDraft("");
                          setPasswordDraftOpen(false);
                        });
                      }
                      if (event.key === "Escape") {
                        setPasswordDraftOpen(false);
                        setPasswordDraft("");
                      }
                    }}
                    className="h-8"
                    placeholder="Set a password"
                    disabled={passwordProtectionPending}
                    aria-label="Password"
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      onSetPassword(report, passwordDraft.trim(), () => {
                        setPasswordDraft("");
                        setPasswordDraftOpen(false);
                      })
                    }
                    disabled={passwordProtectionPending || !passwordDraft.trim()}
                  >
                    {passwordProtectionPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    Set
                  </Button>
                </div>
              ) : null}
              <SettingsRow label="Expires" value={latestSnapshot?.expiresAt ? "Custom" : "Never"} />
              <SettingsRow label="Custom domain" value="Not set" />
            </div>
          </section>

          {report.kind === "folder" ? (
            <section className="rounded-lg border bg-background">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Mini-app build</p>
                  <p className="text-xs text-muted-foreground">
                    {report.buildCommand
                      ? report.buildCommand
                      : "Static folder publishes as-is."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      report.buildStatus === "failed"
                        ? "destructive"
                        : report.buildStatus === "ready"
                          ? "secondary"
                          : "muted"
                    }
                  >
                    {buildStatusLabels[report.buildStatus] ?? report.buildStatus}
                  </Badge>
                  {report.buildCommand ? (
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
                </div>
              </div>
              {report.buildOutputDir ? (
                <p className="border-t px-4 py-2 font-mono text-xs text-muted-foreground">
                  output: {report.buildOutputDir}
                </p>
              ) : null}
              {needsBuild ? (
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                  Build this folder before previewing or publish will build it first.
                </p>
              ) : null}
              {report.buildError ? (
                <p className="whitespace-pre-wrap border-t px-4 py-2 text-xs text-destructive">
                  {report.buildError}
                </p>
              ) : null}
            </section>
          ) : null}

        </div>
      </div>
    </div>
  );
}

function SettingsRow({
  label,
  value,
  control
}: {
  label: string;
  value: string;
  control?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <span className="text-sm">{value}</span>
        {control}
      </div>
    </div>
  );
}

function PreviewPane({
  report,
  publication,
  hasActiveLinks,
  isPublishing,
  publishAsDrop,
  publishPending,
  buildPending,
  publishBlocked,
  onConnect,
  onEdit,
  onPreview,
  onPublish,
  onRequestDelete,
  onRequestRevokeAll
}: {
  report: Report;
  publication: Report["publications"][number] | null;
  hasActiveLinks: boolean;
  isPublishing: boolean;
  publishAsDrop: boolean;
  publishPending: boolean;
  buildPending: boolean;
  publishBlocked: boolean;
  onConnect: () => void;
  onEdit: (report: Report) => void;
  onPreview: (report: Report) => void;
  onPublish: (report: Report, drop: boolean) => void;
  onRequestDelete: (report: Report) => void;
  onRequestRevokeAll: (report: Report) => void;
}) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const frameShellRef = useRef<HTMLDivElement>(null);
  const [frameScale, setFrameScale] = useState(1);
  const src = report.localUrl || "";
  const displayUrl = publication?.publicUrl || report.localUrl || "";
  const activePublicationCount = report.publications.filter((item) => item.active).length;
  const viewport = device === "desktop"
    ? { width: 1280, height: 900, label: "Desktop" }
    : { width: 390, height: 780, label: "Mobile" };

  const copySelectedLink = async () => {
    const url = publication?.publicUrl || report.localUrl || "";
    const ok = url ? await copyToClipboard(url) : false;
    toast[ok ? "success" : "error"](ok ? "Link copied." : "No link to copy.");
  };

  useEffect(() => {
    const shell = frameShellRef.current;
    if (!shell) return;

    const updateScale = () => {
      const availableWidth = shell.clientWidth;
      const nextScale = Math.min(1, Math.max(0.35, availableWidth / viewport.width));
      setFrameScale(Number(nextScale.toFixed(3)));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [viewport.width]);

  return (
    <section className="overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span>Pages</span>
            <span>/</span>
            <span className="truncate font-medium text-foreground">{report.name}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">
              {report.name}
            </h2>
            <Badge variant={hasActiveLinks ? "secondary" : "outline"}>
              {hasActiveLinks ? "Live" : "Draft"}
            </Badge>
            {hasActiveLinks ? (
              <span className="text-xs text-muted-foreground">
                {activePublicationCount} active {activePublicationCount === 1 ? "link" : "links"}
              </span>
            ) : null}
            {report.importedFromCloudflare ? (
              <Badge variant="muted" className="gap-1">
                <CloudDownload className="h-3 w-3" />
                Recovered
              </Badge>
            ) : null}
            {report.sourceMissing ? (
              <Badge variant="destructive" className="gap-1">
                <AlertCircle className="h-3 w-3" />
                Source missing
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasActiveLinks
              ? `Updated ${relativeTime(publication?.updatedAt || report.updatedAt)}`
              : "Not published yet"}
          </p>
        </div>

        <div className="flex max-w-full flex-wrap items-center gap-2">
          {publishBlocked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" onClick={onConnect} variant="secondary">
                  <Cloud className="h-4 w-4" />
                  Publish URL
                </Button>
              </TooltipTrigger>
              <TooltipContent>Connect Cloudflare first</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              onClick={() => onPublish(report, publishAsDrop)}
              disabled={publishPending || buildPending}
            >
              {isPublishing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cloud className="h-4 w-4" />
              )}
              {publishAsDrop ? "Publish short link" : "Publish URL"}
            </Button>
          )}
          {publication?.publicUrl ? (
            <>
              <Button asChild size="sm" variant="outline">
                <a href={publication.publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Open
                </a>
              </Button>
              <Button variant="outline" size="sm" onClick={copySelectedLink}>
                <Copy className="h-4 w-4" />
                Copy
              </Button>
            </>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => onEdit(report)}>
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" className="h-9 w-9" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onPreview(report)}>
                <Monitor className="h-4 w-4" />
                Open full preview
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {hasActiveLinks ? (
                <>
                  <DropdownMenuItem onSelect={() => onRequestRevokeAll(report)}>
                    <WifiOff className="h-4 w-4" />
                    Take links offline
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem
                onSelect={() => onRequestDelete(report)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Delete page
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div ref={frameShellRef} className="min-h-[620px] overflow-auto bg-muted/30 p-4">
        <div
          className={cn(
            "mx-auto overflow-hidden rounded-lg border bg-background shadow-sm",
            device === "mobile" ? "w-fit" : "max-w-full"
          )}
          style={{
            width: viewport.width * frameScale,
            minHeight: viewport.height * frameScale + 40
          }}
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
            <div className="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              {displayUrl || "Preview URL"}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-md border bg-background p-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant={device === "desktop" ? "secondary" : "ghost"}
                    className="h-7 w-7"
                    onClick={() => setDevice("desktop")}
                    aria-label="Desktop preview"
                  >
                    <Monitor className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Desktop preview</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant={device === "mobile" ? "secondary" : "ghost"}
                    className="h-7 w-7"
                    onClick={() => setDevice("mobile")}
                    aria-label="Mobile preview"
                  >
                    <Smartphone className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Mobile preview</TooltipContent>
              </Tooltip>
            </div>
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {viewport.label}
            </Badge>
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </div>
          {src ? (
            <div
              style={{
                width: viewport.width * frameScale,
                height: viewport.height * frameScale
              }}
            >
              <iframe
                src={src}
                title={`Preview of ${report.name}`}
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
                referrerPolicy="no-referrer"
                className="origin-top-left border-0 bg-background"
                style={{
                  width: viewport.width,
                  height: viewport.height,
                  transform: `scale(${frameScale})`
                }}
              />
            </div>
          ) : (
            <div className="flex h-80 items-center justify-center text-sm text-muted-foreground">
              Nothing to preview yet.
            </div>
          )}
        </div>
      </div>
    </section>
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

  // While publishing we show an honest indeterminate bar — the real deploy time
  // is variable and we don't fake discrete stages.
  if (active) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border bg-background p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Publishing…</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deploying to Cloudflare — usually a few seconds ({formatElapsed(elapsedMs)})
            </p>
          </div>
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted">
          <motion.div
            className="h-full w-1/3 rounded-full bg-sky-500"
            animate={{ x: ["-110%", "330%"] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
      </motion.div>
    );
  }

  // Success: the public URL is the payoff — make it the copyable hero.
  const url = summary?.url ?? "";
  const copyLink = async () => {
    const ok = await copyToClipboard(url);
    toast[ok ? "success" : "error"](ok ? "Link copied." : "Could not copy link.");
  };
  const copyShare = async () => {
    const ok = await copyToClipboard(`Take a look: ${url}`);
    toast[ok ? "success" : "error"](ok ? "Share message copied." : "Could not copy.");
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <p className="text-sm font-medium text-emerald-900">
          Live — published in {formatElapsed(summary?.elapsedMs ?? 0)}
        </p>
      </div>
      <p className="mt-1 text-xs text-emerald-800">
        {summary?.expiresAt
          ? `Expires ${new Date(summary.expiresAt).toLocaleString()}`
          : "Expires never"}
      </p>
      {url ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={copyLink}
            title="Click to copy"
            className="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-2 text-left font-mono text-xs hover:bg-accent"
          >
            {url}
          </button>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={copyLink}>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
            <Button size="sm" variant="ghost" onClick={copyShare}>
              Share message
            </Button>
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}

function ActivityDock({ activities }: { activities: ActivityItem[] }) {
  const visible = activities.slice(0, 3);
  if (visible.length === 0) return null;

  return (
    <footer className="hidden h-14 shrink-0 items-center gap-4 border-t bg-background px-6 lg:flex">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold">Activity</span>
        <Badge variant="secondary" className="gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Live
        </Badge>
        <Badge variant="muted">{activities.length}</Badge>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {visible.map((item) => {
          const Icon = activityIcon(item.status);
          return (
            <div
              key={item.id}
              className="flex min-w-[240px] items-center gap-2 rounded-full bg-muted/40 px-3 py-1.5 text-xs"
            >
              <Icon className={cn("h-3.5 w-3.5 shrink-0", activityColor(item.status))} />
              <span className="truncate">{item.title}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{relativeTime(item.createdAt)}</span>
            </div>
          );
        })}
      </div>
      <span className="shrink-0 text-sm text-muted-foreground">Recent</span>
    </footer>
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
  reports,
  cloudflare,
  connected,
  feedback,
  analyticsEnabled,
  defaultExpiry,
  cloudflareSyncEnabled,
  cloudflareSyncPending,
  onToggleCloudflareSync
}: {
  reports: Report[];
  cloudflare: CloudflareStatus | undefined;
  connected: boolean;
  feedback: FeedbackConfig | null;
  analyticsEnabled: boolean;
  defaultExpiry: string | undefined;
  cloudflareSyncEnabled: boolean;
  cloudflareSyncPending: boolean;
  onToggleCloudflareSync: (enabled: boolean) => void;
}) {
  return (
    <div className="h-full overflow-y-auto scroll-smooth bg-background">
      <section className="mx-auto max-w-4xl space-y-5 px-5 py-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Publishing account, project, link expiry, private analytics, and optional audience reactions.
          </p>
        </div>
        <section
          id={settingsSectionId("publishing")}
          aria-label="Publishing"
          className="scroll-mt-5"
        >
          <CloudflareConnect
            cloudflare={cloudflare}
            autoSyncEnabled={cloudflareSyncEnabled}
            autoSyncPending={cloudflareSyncPending}
            onToggleAutoSync={onToggleCloudflareSync}
          />
        </section>
        <section
          id={settingsSectionId("deploy-history")}
          aria-label="Deploy history"
          className="scroll-mt-5"
        >
          <DeployHistory connected={connected} />
        </section>
        <section
          id={settingsSectionId("link-defaults")}
          aria-label="Link defaults"
          className="scroll-mt-5"
        >
          <DefaultExpiryCard defaultExpiry={defaultExpiry} />
        </section>
        <section
          id={settingsSectionId("analytics")}
          aria-labelledby="settings-analytics-title"
          className="scroll-mt-5 space-y-4"
        >
          <div>
            <h3 id="settings-analytics-title" className="text-base font-semibold">
              Analytics
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Enable private tracking, review access activity, and optionally collect audience reactions.
            </p>
          </div>
          <FeedbackCard connected={connected} feedback={feedback} />
          <ActivityPanel
            publications={reports.flatMap((report) => report.publications)}
            enabled={analyticsEnabled}
            global
          />
        </section>
      </section>
    </div>
  );
}
