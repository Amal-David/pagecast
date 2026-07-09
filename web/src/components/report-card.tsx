import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Eye,
  GripVertical,
  Loader2,
  Lock,
  MoreVertical,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
  Upload,
  Zap
} from "lucide-react";
import { Card } from "@/components/ui/card";
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
import { PublicationRow } from "@/components/publication-row";
import {
  useAutoSync,
  useDeleteReport,
  usePasswordProtection,
  usePublishSnapshot,
  useRevokeAll
} from "@/hooks/use-pagecast";
import { cn } from "@/lib/utils";
import type { Report } from "@/lib/types";

interface ReportCardProps {
  report: Report;
  onPreview: (report: Report) => void;
  onEdit: (report: Report) => void;
}

export function ReportCard({ report, onPreview, onEdit }: ReportCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: report.id });

  const publish = usePublishSnapshot();
  const revokeAll = useRevokeAll();
  const deleteReport = useDeleteReport();
  const autoSync = useAutoSync();
  const passwordProtection = usePasswordProtection();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [passwordDraftOpen, setPasswordDraftOpen] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Publish-time choice: a "drop" gets a short, shareable (guessable) link;
  // otherwise the link is long and hard to guess. Default off = private.
  const [publishAsDrop, setPublishAsDrop] = useState(false);

  // Collapse the draft input whenever protection state changes underneath us.
  useEffect(() => {
    setPasswordDraftOpen(false);
    setPasswordDraft("");
  }, [report.passwordProtected]);

  const handlePasswordToggle = (enabled: boolean) => {
    if (enabled) {
      setPasswordDraft("");
      setPasswordDraftOpen(true);
      return;
    }
    setPasswordDraftOpen(false);
    passwordProtection.mutate({ id: report.id, enabled: false });
  };

  const commitPassword = () => {
    const next = passwordDraft.trim();
    if (!next) return;
    passwordProtection.mutate(
      { id: report.id, enabled: true, password: next },
      {
        onSuccess: () => {
          setPasswordDraft("");
          setPasswordDraftOpen(false);
        }
      }
    );
  };

  const activePublications = report.publications.filter((p) => p.active);
  const hasActive = activePublications.length > 0;
  const isPathReport = report.kind === "path";

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout
      transition={{ type: "spring", stiffness: 600, damping: 40 }}
      className={cn(isDragging && "z-10 opacity-80")}
    >
      <Card
        className={cn(
          "overflow-hidden transition-shadow",
          isDragging && "shadow-lg ring-1 ring-ring"
        )}
      >
        <div className="flex items-start gap-2 p-3">
          <button
            type="button"
            className="mt-0.5 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-medium">{report.name}</h3>
              {report.kind === "upload" ? (
                <Badge variant="muted" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
                  <Upload className="h-2.5 w-2.5" />
                  upload
                </Badge>
              ) : null}
              {report.sourceMissing ? (
                <Badge variant="destructive" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
                  <AlertCircle className="h-2.5 w-2.5" />
                  source missing
                </Badge>
              ) : null}
            </div>
            {report.sourcePath ? (
              <p className="truncate text-[11px] text-muted-foreground">
                {report.sourcePath}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => onPreview(report)}
              aria-label="Preview report"
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => onEdit(report)}
              aria-label="Edit report"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label="More actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => publish.mutate({ id: report.id, drop: publishAsDrop })}
                  disabled={publish.isPending}
                >
                  <RefreshCw className="h-4 w-4" />
                  {publishAsDrop ? "Publish short link" : "Publish now"}
                </DropdownMenuItem>
                {hasActive ? (
                  <DropdownMenuItem
                    onClick={() => revokeAll.mutate(report.id)}
                    disabled={revokeAll.isPending}
                  >
                    Take all links offline
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {isPathReport ? (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <div className="flex flex-col">
              <span className="text-xs font-medium">Auto-sync</span>
              <span className="text-[11px] text-muted-foreground">
                {report.autoSync
                  ? "Every save republishes automatically"
                  : "Publish on your command"}
              </span>
            </div>
            <Switch
              checked={report.autoSync}
              disabled={autoSync.isPending}
              onCheckedChange={(enabled) =>
                autoSync.mutate({ id: report.id, enabled })
              }
              aria-label="Toggle auto-sync"
            />
          </div>
        ) : null}

        <div className="border-t">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium transition-colors hover:bg-accent/50"
            aria-expanded={advancedOpen}
          >
            <span className="flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              Advanced
              {report.passwordProtected ? (
                <Lock className="h-3 w-3 text-muted-foreground" />
              ) : null}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                advancedOpen && "rotate-180"
              )}
            />
          </button>

          {advancedOpen ? (
            <div className="space-y-3 px-3 pb-3">
              <div className="flex items-center justify-between">
                <div className="flex flex-col pr-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <Zap className="h-3 w-3 text-muted-foreground" />
                    Short public link
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {publishAsDrop
                      ? "Short memorable URL. Easier to share, easier to guess."
                      : "Long private URL. Harder to guess."}
                  </span>
                </div>
                <Switch
                  checked={publishAsDrop}
                  onCheckedChange={setPublishAsDrop}
                  aria-label="Use a short public link"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col pr-2">
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      Password protection
                      {report.passwordProtected ? (
                        <Lock className="h-3 w-3 text-muted-foreground" />
                      ) : null}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {report.passwordProtected
                        ? "Visitors must enter a password"
                        : "Anyone with the link can view"}
                    </span>
                  </div>
                  <Switch
                    checked={report.passwordProtected || passwordDraftOpen}
                    disabled={passwordProtection.isPending}
                    onCheckedChange={handlePasswordToggle}
                    aria-label="Toggle password protection"
                  />
                </div>
                {passwordDraftOpen ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      autoFocus
                      type="password"
                      value={passwordDraft}
                      onChange={(event) => setPasswordDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitPassword();
                        if (event.key === "Escape") {
                          setPasswordDraftOpen(false);
                          setPasswordDraft("");
                        }
                      }}
                      className="h-7 text-xs"
                      placeholder="Set a password"
                      disabled={passwordProtection.isPending}
                      aria-label="Password"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={commitPassword}
                      disabled={passwordProtection.isPending || !passwordDraft.trim()}
                      aria-label="Set password"
                    >
                      {passwordProtection.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {hasActive ? (
          <div className="space-y-1.5 border-t bg-muted/20 p-2">
            {activePublications.map((publication) => (
              <PublicationRow
                key={publication.token}
                publication={publication}
              />
            ))}
          </div>
        ) : null}
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this page?</AlertDialogTitle>
            <AlertDialogDescription>
              “{report.name}” and any published links will be taken offline. This
              can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleteReport.mutate(report.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
