import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAddPath } from "@/hooks/use-pagecast";

export function AddReport() {
  const [path, setPath] = useState("");
  const addPath = useAddPath();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = path.trim();
    if (!value) return;
    addPath.mutate(value, { onSuccess: () => setPath("") });
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <Input
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="/Users/you/reports/index.html"
        autoComplete="off"
        spellCheck={false}
        disabled={addPath.isPending}
        aria-label="Local HTML or Markdown path or file URL"
      />
      <Button type="submit" disabled={addPath.isPending || !path.trim()}>
        {addPath.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
        Add
      </Button>
    </form>
  );
}
