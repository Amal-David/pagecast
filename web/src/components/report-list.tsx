import { useEffect, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { AnimatePresence } from "framer-motion";
import { FileText } from "lucide-react";
import { ReportCard } from "@/components/report-card";
import { useReorder } from "@/hooks/use-pagecast";
import type { Report } from "@/lib/types";

interface ReportListProps {
  reports: Report[];
  onPreview: (report: Report) => void;
  onEdit: (report: Report) => void;
}

export function ReportList({ reports, onPreview, onEdit }: ReportListProps) {
  // Local mirror gives instant drag feedback; react-query stays the source of
  // truth and the optimistic reorder mutation reconciles it.
  const [items, setItems] = useState<Report[]>(reports);
  const reorder = useReorder();

  useEffect(() => {
    setItems(reports);
  }, [reports]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((item) => item.id === active.id);
    const newIndex = items.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    reorder.mutate(next.map((item) => item.id));
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Nothing published yet</p>
          <p className="text-xs text-muted-foreground">
            Add an HTML or Markdown file above, then publish it in one click.
          </p>
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {items.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                onPreview={onPreview}
                onEdit={onEdit}
              />
            ))}
          </AnimatePresence>
        </div>
      </SortableContext>
    </DndContext>
  );
}
