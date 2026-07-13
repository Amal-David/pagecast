import { useEffect, useMemo, useState } from "react";
import { Check, Cloud, Copy, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AddReport } from "@/components/add-report";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCloudflareConnectionJob } from "@/hooks/use-cloudflare";
import { api } from "@/lib/api";
import { copyToClipboard } from "@/lib/format";
import type { CloudflareConnectionJob } from "@/lib/types";

const AGENT_PROMPT = "Publish this as a Pagecast";
const SCOPES = ["account:read", "user:read", "pages:write"];

const statusCopy: Record<CloudflareConnectionJob["status"], string> = {
  preparing_wrangler: "Preparing Wrangler…",
  awaiting_consent: "Waiting for Cloudflare permission…",
  discovering_accounts: "Finding your Cloudflare account…",
  creating_home: "Creating your Pagecast Home…",
  connected: "Pagecast Home connected",
  failed: "Connection needs attention"
};

function normalizeProjectName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
}

export function PagecastHomeOnboarding({ suggestedProjectName }: { suggestedProjectName: string }) {
  const connect = useCloudflareConnectionJob();
  const [projectName, setProjectName] = useState(suggestedProjectName);
  const [job, setJob] = useState<CloudflareConnectionJob | null>(null);
  const normalizedProjectName = useMemo(
    () => normalizeProjectName(projectName) || suggestedProjectName,
    [projectName, suggestedProjectName]
  );

  useEffect(() => {
    if (!job || job.status === "connected" || job.status === "failed" || job.needsAccountChoice) {
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.getCloudflareConnectionJob(job.jobId);
        setJob(next);
        if (next.status === "connected") {
          toast.success("Pagecast Home is ready.");
          window.location.reload();
        }
      } catch (error) {
        setJob((current) => current ? { ...current, status: "failed", error: error instanceof Error ? error.message : "Could not read connection progress." } : current);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [job]);

  const start = async (accountId?: string) => {
    const next = await connect.mutateAsync({
      projectName: normalizedProjectName,
      ...(accountId ? { accountId } : {})
    });
    setJob(next);
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto grid min-h-full max-w-5xl content-center gap-5 px-4 py-8 lg:grid-cols-[1.15fr_.85fr] lg:px-8">
        <Card className="overflow-hidden border-primary/20 shadow-sm">
          <CardHeader className="border-b bg-gradient-to-br from-primary/10 via-background to-background">
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Cloud className="h-5 w-5" />
            </div>
            <CardTitle className="text-xl">Create your Pagecast Home</CardTitle>
            <CardDescription className="max-w-xl">
              One Cloudflare subdomain holds every page you publish. Connect here once, then Pagecast and your agents reuse it automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-6">
            <label className="block space-y-2 text-sm font-medium">
              Pagecast Home address
              <div className="flex items-center rounded-md border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
                <Input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  disabled={Boolean(job && job.status !== "failed")}
                  className="border-0 shadow-none focus-visible:ring-0"
                  aria-label="Pagecast Home subdomain"
                />
                <span className="pr-3 font-mono text-xs text-muted-foreground">.pages.dev</span>
              </div>
            </label>

            <div className="rounded-lg border bg-muted/25 p-4 text-sm">
              <p className="font-medium">Cloudflare will call the authorizing app Wrangler.</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Pagecast opens Cloudflare’s browser-hosted permission screen. Credentials stay with Wrangler.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {SCOPES.map((scope) => <code key={scope} className="rounded bg-background px-2 py-1 text-[11px]">{scope}</code>)}
              </div>
            </div>

            {job ? (
              <div className="rounded-lg border p-4" aria-live="polite">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {job.status === "connected" ? <Check className="h-4 w-4 text-emerald-600" /> : job.status === "failed" ? <Cloud className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}
                  {statusCopy[job.status]}
                </div>
                {job.error ? <p className="mt-2 text-xs text-destructive">{job.error}</p> : null}
                {job.authorizationUrl ? (
                  <Button className="mt-3" size="sm" variant="outline" onClick={() => window.open(job.authorizationUrl, "_blank", "noopener,noreferrer") }>
                    Open Cloudflare <ExternalLink className="h-4 w-4" />
                  </Button>
                ) : null}
                {job.needsAccountChoice ? (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-muted-foreground">Choose the account that should own this Home.</p>
                    <Select onValueChange={(accountId) => void start(accountId)}>
                      <SelectTrigger><SelectValue placeholder="Choose a Cloudflare account" /></SelectTrigger>
                      <SelectContent>{job.accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name || "Cloudflare account"}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            ) : null}

            <Button className="w-full" size="lg" disabled={connect.isPending || Boolean(job && job.status !== "failed")} onClick={() => void start()}>
              {connect.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              {job?.status === "failed" ? "Try connecting again" : "Connect Cloudflare"}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Agent-first publishing</CardTitle>
              <CardDescription>Once connected, tell your coding agent exactly this:</CardDescription>
            </CardHeader>
            <CardContent>
              <button type="button" className="flex w-full items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4 text-left font-mono text-sm hover:bg-muted/50" onClick={async () => { await copyToClipboard(AGENT_PROMPT); toast.success("Agent prompt copied."); }}>
                <span>“{AGENT_PROMPT}”</span><Copy className="h-4 w-4 shrink-0" />
              </button>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">Your agent publishes immediately and returns the URL. Repeating it for the same item updates that URL.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Or drop it here</CardTitle>
              <CardDescription>HTML, Markdown, or a deployable static folder.</CardDescription>
            </CardHeader>
            <CardContent><AddReport /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
