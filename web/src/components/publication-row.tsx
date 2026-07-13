import { useEffect, useState } from "react";
import {
  Check,
  Clock,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  EXPIRY_PRESETS,
  copyToClipboard,
  expiryLabel,
  relativeTime
} from "@/lib/format";
import {
  useAdoptPublicationTarget,
  useRenameSlug,
  useRevokePublication,
  useSetExpiry,
  useSyncPublication
} from "@/hooks/use-pagecast";
import type { Publication } from "@/lib/types";
import { PublicationActivitySummary } from "@/components/activity-panel";

interface PublicationRowProps {
  publication: Publication;
  analyticsEnabled?: boolean;
}

export function PublicationRow({ publication, analyticsEnabled = false }: PublicationRowProps) {
  const rename = useRenameSlug();
  const sync = useSyncPublication();
  const revoke = useRevokePublication();
  const setExpiry = useSetExpiry();
  const adoptTarget = useAdoptPublicationTarget();

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
      ok ? "Link copied." : "Couldn’t copy the link."
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
            <Badge
              variant={publication.expired ? "destructive" : "muted"}
              className="shrink-0 px-1.5 py-0 text-[10px]"
            >
              {publication.expired ? "expired" : "published"}
            </Badge>
            {isSnapshot ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => setEditing(true)}
                disabled={!publication.targetAttributed}
                aria-label="Edit custom URL"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            ) : null}
          </div>
        )}
        {!editing ? (
          <><div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {!publication.targetAttributed ? (
              <button
                type="button"
                className="font-medium text-amber-700 underline-offset-2 hover:underline"
                disabled={adoptTarget.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Attach this legacy link to the currently selected Cloudflare account and project?"
                    )
                  ) {
                    adoptTarget.mutate(publication.token);
                  }
                }}
              >
                {adoptTarget.isPending ? "Attaching…" : "Attach selected project"}
              </button>
            ) : null}
            <span className="truncate">
              Last synced {relativeTime(publication.updatedAt)}
            </span>
            {isSnapshot ? (
              <>
                <span aria-hidden="true">·</span>
                <Select
                  value=""
                  disabled={setExpiry.isPending || !publication.targetAttributed}
                  onValueChange={(value) =>
                    setExpiry.mutate({ token: publication.token, expires: value })
                  }
                >
                  <SelectTrigger
                    className="h-6 w-auto gap-1 border-0 bg-transparent px-1 py-0 text-[11px] shadow-none focus:ring-0 [&>span]:line-clamp-none"
                    aria-label="Set link expiry"
                  >
                    <Clock className="h-3 w-3 shrink-0" />
                    <span
                      className={
                        publication.expired ? "text-destructive" : undefined
                      }
                    >
                      {setExpiry.isPending
                        ? "Updating…"
                        : expiryLabel(publication.expiresAt, publication.expired)}
                    </span>
                  </SelectTrigger>
                  <SelectContent align="start">
                    {EXPIRY_PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : null}
          </div><PublicationActivitySummary publicationId={publication.token} enabled={analyticsEnabled} /></>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={handleCopy}
          disabled={!url}
          aria-label="Copy link"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        {isSnapshot ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => sync.mutate(publication.token)}
            disabled={sync.isPending || !publication.targetAttributed}
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
          disabled={revoke.isPending || !publication.targetAttributed}
          aria-label="Take link offline"
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
