import { useRef, useState } from "react";
import { FolderPlus, Loader2, Plus, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  useAddFolder,
  useAddPath,
  useUploadFile,
  useUploadFolder
} from "@/hooks/use-pagecast";
import { cn } from "@/lib/utils";

type AddMode = "path" | "folder";

export function AddReport() {
  const [mode, setMode] = useState<AddMode>("path");
  const [path, setPath] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [buildOutputDir, setBuildOutputDir] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const addPath = useAddPath();
  const addFolder = useAddFolder();
  const uploadFile = useUploadFile();
  const uploadFolder = useUploadFolder();

  const busy =
    addPath.isPending ||
    addFolder.isPending ||
    uploadFile.isPending ||
    uploadFolder.isPending;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = path.trim();
    if (!value) return;
    if (mode === "folder") {
      addFolder.mutate(
        {
          path: value,
          buildCommand: buildCommand.trim(),
          buildOutputDir: buildOutputDir.trim()
        },
        {
          onSuccess: () => {
            setPath("");
            setBuildCommand("");
            setBuildOutputDir("");
          }
        }
      );
      return;
    }
    addPath.mutate(value, { onSuccess: () => setPath("") });
  };

  const uploadFiles = (files: File[]) => {
    if (files.length === 0) return;
    const folderFiles = files.filter((file) => file.webkitRelativePath);
    if (folderFiles.length > 0 || files.length > 1) {
      uploadFolder.mutate(files);
      return;
    }
    uploadFile.mutate(files[0]);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    uploadFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border border-dashed bg-muted/20 p-2 transition-colors",
        dragging && "border-primary bg-accent"
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
        <button
          type="button"
          onClick={() => setMode("path")}
          className={cn(
            "rounded px-2 py-1.5 text-xs font-medium transition-colors",
            mode === "path" ? "bg-background shadow-sm" : "text-muted-foreground"
          )}
        >
          File path
        </button>
        <button
          type="button"
          onClick={() => setMode("folder")}
          className={cn(
            "rounded px-2 py-1.5 text-xs font-medium transition-colors",
            mode === "folder" ? "bg-background shadow-sm" : "text-muted-foreground"
          )}
        >
          Folder app
        </button>
      </div>

      <form onSubmit={submit} className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={
              mode === "folder"
                ? "/Users/you/app/dist"
                : "/Users/you/reports/index.html"
            }
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label={
              mode === "folder"
                ? "Local folder path"
                : "Local HTML or Markdown path or file URL"
            }
          />
          <Button type="submit" disabled={busy || !path.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
        </div>

        {mode === "folder" ? (
          <div className="grid gap-2">
            <Input
              value={buildCommand}
              onChange={(event) => setBuildCommand(event.target.value)}
              placeholder="Build command, e.g. npm run build"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-label="Build command"
            />
            <Input
              value={buildOutputDir}
              onChange={(event) => setBuildOutputDir(event.target.value)}
              placeholder="Output directory, e.g. dist"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-label="Build output directory"
            />
          </div>
        ) : null}
      </form>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-4 w-4" />
          Upload
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => folderInputRef.current?.click()}
        >
          <FolderPlus className="h-4 w-4" />
          Folder
        </Button>
      </div>

      <p className="text-[11px] leading-4 text-muted-foreground">
        Drop HTML/Markdown files or deployable static folders here.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".html,.htm,.md,.markdown,text/html,text/markdown"
        onChange={(event) => {
          uploadFiles(Array.from(event.target.files || []));
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        multiple
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => {
          uploadFiles(Array.from(event.target.files || []));
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
