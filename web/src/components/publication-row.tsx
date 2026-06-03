import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { copyToClipboard, relativeTime } from "@/lib/format";
import {
  useRenameSlug,
  useRevokePublication,
  useSyncPublication
} from "@/hooks/use-pagecast";
import type { Publication } from "@/lib/types";

interface PublicationRowProps {
  publication: Publication;
}

export function PublicationRow({ publication }: PublicationRowProps) {
  const rename = useRenameSlug();
  const sync = useSyncPublication();
  const revoke = useRevokePublication();

  const [editing, setEditing] = useState(false);
  const [slugDraft, setSlugDraft] = useState(publication.slug);

  useEffect(() => {
    if (!editing) setSlugDraft(publication.slug);
  }, [publication.slug, editing]);

  const url = publication.publicUrl || publication.localUrl || "";
  const isSnapshot = publication.kind === "snapshot";

  const handleCopy = async () => {
    if (!url) return;
    const ok = await copyToClipboard(url);
    toast[ok ? "success" : "error"](
      ok ? "URL copied." : "Could not copy URL."
    );
  };

  const commitSlug = () => {
    const next = slugDraft.trim();
    if (!next || next === publication.slug) {
      setEditing(false);
      setSlugDraft(publication.slug);
      return;
    }
    rename.mutate(
      { token: publication.token, slug: next },
      {
        onSuccess: () => setEditing(false),
        // Keep editing open on 400/409 so the user can correct the value.
        onError: () => setSlugDraft(next)
      }
    );
  };

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              value={slugDraft}
              onChange={(event) => setSlugDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitSlug();
                if (event.key === "Escape") {
                  setEditing(false);
                  setSlugDraft(publication.slug);
                }
              }}
              className="h-7 font-mono text-xs"
              placeholder="custom-url"
              disabled={rename.isPending}
              aria-label="Custom URL slug"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={commitSlug}
              disabled={rename.isPending}
              aria-label="Save custom URL"
            >
              {rename.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => {
                setEditing(false);
                setSlugDraft(publication.slug);
              }}
              disabled={rename.isPending}
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-xs">
              {publication.slug}
            </span>
            {isSnapshot ? (
              <Badge variant="muted" className="shrink-0 px-1.5 py-0 text-[10px]">
                snapshot
              </Badge>
            ) : null}
            {isSnapshot ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => setEditing(true)}
                aria-label="Edit custom URL"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        )}
        {!editing ? (
          <p className="truncate text-[11px] text-muted-foreground">
            Last synced {relativeTime(publication.updatedAt)}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={handleCopy}
          disabled={!url}
          aria-label="Copy URL"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        {isSnapshot ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => sync.mutate(publication.token)}
            disabled={sync.isPending}
            aria-label="Sync published link"
          >
            <RefreshCw
              className={sync.isPending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
            />
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => revoke.mutate(publication.token)}
          disabled={revoke.isPending}
          aria-label="Revoke link"
        >
          {revoke.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
