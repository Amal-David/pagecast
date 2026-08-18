import { useState } from "react";
import { Check, Globe, Loader2, Trash2, TriangleAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAddCustomDomain,
  useCustomDomain,
  useRemoveCustomDomain
} from "@/hooks/use-pagecast";
import type { CustomDomainStatus } from "@/lib/types";

interface CustomDomainCardProps {
  // Every read reconciles against Cloudflare, so stay idle until a target exists.
  cloudflareReady: boolean;
}

// Cloudflare's own vocabulary, phrased for someone who did not read its docs.
const STATUS_COPY: Record<CustomDomainStatus, { label: string; tone: "ok" | "wait" | "bad" }> = {
  active: { label: "Live", tone: "ok" },
  initializing: { label: "Starting", tone: "wait" },
  pending: { label: "Waiting for DNS", tone: "wait" },
  deactivated: { label: "Deactivated", tone: "bad" },
  blocked: { label: "Blocked", tone: "bad" },
  error: { label: "Error", tone: "bad" }
};

export function CustomDomainCard({ cloudflareReady }: CustomDomainCardProps) {
  const [draft, setDraft] = useState("");
  const domainQuery = useCustomDomain(cloudflareReady);
  const addDomain = useAddCustomDomain();
  const removeDomain = useRemoveCustomDomain();

  const result = domainQuery.data;
  const domain = result?.customDomain ?? null;
  const status = domain ? STATUS_COPY[domain.status] : null;
  const pending = addDomain.isPending || removeDomain.isPending;

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4" />
          Custom domain
        </CardTitle>
        <CardDescription>
          Serve your published links from your own hostname instead of the
          Cloudflare-assigned one. A subdomain such as{" "}
          <span className="font-mono text-xs">docs.example.com</span> only needs a
          CNAME record; an apex domain must be a zone on this Cloudflare account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!cloudflareReady ? (
          <p className="text-sm text-muted-foreground">
            Connect Cloudflare and choose a Pages project first.
          </p>
        ) : domainQuery.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking with Cloudflare…
          </p>
        ) : domainQuery.isError ? (
          <p className="text-sm text-destructive">
            {domainQuery.error instanceof Error
              ? domainQuery.error.message
              : "Could not read the custom domain."}
          </p>
        ) : domain ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-sm">{domain.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                {status ? (
                  <Badge variant={status.tone === "ok" ? "secondary" : "outline"}>
                    {status.tone === "ok" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : status.tone === "bad" ? (
                      <TriangleAlert className="mr-1 h-3 w-3" />
                    ) : (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    )}
                    {status.label}
                  </Badge>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Remove ${domain.name}`}
                  onClick={() => removeDomain.mutate(domain.name)}
                >
                  {removeDomain.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Links currently use{" "}
              <span className="font-mono">{result?.publicBaseUrl}</span>
            </p>

            {domain.error ? (
              <p className="text-sm text-destructive">Cloudflare reports: {domain.error}</p>
            ) : null}

            {domain.status !== "active" ? (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                {/* Do not let a pending domain read as finished — links keep
                    using the pages.dev origin until Cloudflare serves it. */}
                <p className="text-xs text-muted-foreground">
                  Links keep using the Cloudflare origin until this domain is live.
                </p>
                {/* Which half is outstanding. "Pending" alone cannot tell
                    someone whether to fix DNS or wait on the certificate. */}
                {result?.progress?.validation || result?.progress?.verification ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {result.progress.validation ? (
                      <>
                        <dt>DNS validation</dt>
                        <dd className="font-mono">{result.progress.validation}</dd>
                      </>
                    ) : null}
                    {result.progress.verification ? (
                      <>
                        <dt>Certificate</dt>
                        <dd className="font-mono">{result.progress.verification}</dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
                {result?.dns?.record ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Add this record at whichever DNS provider hosts{" "}
                      {result.dns.record.zone}:
                    </p>
                    <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-xs">
                      {result.dns.record.type}  {result.dns.record.name}  →{" "}
                      {result.dns.record.value}
                    </pre>
                  </div>
                ) : result?.dns?.instructions ? (
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {result.dns.instructions}
                  </p>
                ) : null}
              </div>
            ) : null}

            {result && result.staleMetadata > 0 ? (
              <p className="text-xs text-muted-foreground">
                {result.staleMetadata} live page
                {result.staleMetadata === 1 ? "" : "s"} still carry the previous
                origin in their social metadata. Re-publish to refresh it.
              </p>
            ) : null}
          </>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = draft.trim();
              if (!value) return;
              addDomain.mutate(value, { onSuccess: () => setDraft("") });
            }}
          >
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="docs.example.com"
              aria-label="Custom domain"
              disabled={pending}
            />
            <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
              {addDomain.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Add"
              )}
            </Button>
          </form>
        )}

        {/* Attached at Cloudflare but not tracked here. Adding one by name
            adopts it, so offer that rather than just naming it. */}
        {result?.unadopted?.length ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Also attached at Cloudflare but not tracked by Pagecast:
            </p>
            <ul className="space-y-1">
              {result.unadopted.map((name) => (
                <li key={name} className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">{name}</span>
                  {domain ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => addDomain.mutate(name)}
                    >
                      Use this
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
