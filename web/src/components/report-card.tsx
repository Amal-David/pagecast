import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion } from "framer-motion";
import {
  Eye,
  GripVertical,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
  Upload
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  const [confirmDelete, setConfirmDelete] = useState(false);

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
                  onClick={() => publish.mutate(report.id)}
                  disabled={publish.isPending}
                >
                  <RefreshCw className="h-4 w-4" />
                  Publish now
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
