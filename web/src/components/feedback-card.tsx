import { BarChart3, Check, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFeedbackSetup } from "@/hooks/use-pagecast";
import type { FeedbackConfig } from "@/lib/types";
import { isAnalyticsEnabled } from "@/lib/utils";

interface FeedbackCardProps {
  connected: boolean;
  feedback: FeedbackConfig | null;
}

export function FeedbackCard({ connected, feedback }: FeedbackCardProps) {
  const setup = useFeedbackSetup();
  const enabled = isAnalyticsEnabled(feedback);
  const reactionsEnabled = feedback?.reactionsEnabled === true;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            Private analytics
          </CardTitle>
          <CardDescription>
            See cookieless page activity in your own Cloudflare D1 database.
          </CardDescription>
        </div>
        {enabled ? (
          <Badge variant="secondary" className="gap-1">
            <Check className="h-3 w-3" />
            Enabled
          </Badge>
        ) : (
          <Badge variant="outline">Off</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {enabled ? (
          <><p className="text-sm text-muted-foreground">
            View tracking is active on every Home page. Detailed events are kept
            for 30 days; aggregate totals remain. Raw IP addresses are never stored.
          </p>
          {!reactionsEnabled ? (
            <Button variant="outline" className="w-full" disabled={setup.isPending} onClick={() => setup.mutate({ reactions: true })}>
              {setup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Enable optional reactions bar
            </Button>
          ) : null}</>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {connected
                ? "One-time setup deploys a tiny Worker + D1 database to your Cloudflare account and instruments existing Home pages. Reactions remain off."
                : "Connect Cloudflare first — analytics is deployed to your own account."}
            </p>
            <Button
              className="w-full"
              disabled={!connected || setup.isPending}
              onClick={() => setup.mutate({ reactions: false })}
            >
              {setup.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deploying analytics…
                </>
              ) : (
                "Enable analytics"
              )}
            </Button>
            {setup.isError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                Setup didn't complete. Make sure a workers.dev subdomain is
                enabled in your Cloudflare dashboard, then try again.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
