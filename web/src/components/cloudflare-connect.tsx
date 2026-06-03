import { useState } from "react";
import { Check, Cloud, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  useCloudflareAccount,
  useCloudflareConnect
} from "@/hooks/use-cloudflare";
import type { CloudflareStatus } from "@/lib/types";

interface CloudflareConnectProps {
  cloudflare: CloudflareStatus | undefined;
}

export function CloudflareConnect({ cloudflare }: CloudflareConnectProps) {
  const connect = useCloudflareConnect();
  const selectAccount = useCloudflareAccount();
  const [chosenAccount, setChosenAccount] = useState<string>("");

  const loggedIn = Boolean(cloudflare?.loggedIn);
  const accounts = cloudflare?.accounts ?? [];
  const accountName = cloudflare?.accountName ?? "";
  const projectName = cloudflare?.projectName ?? "";
  // Multiple accounts but none selected yet → ask the user to choose.
  const needsAccountChoice = loggedIn && accounts.length > 1 && !accountName;
  const connected = loggedIn && Boolean(accountName) && Boolean(projectName);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4" />
            Cloudflare Pages
          </CardTitle>
          <CardDescription>
            Publish durable snapshots to your own account.
          </CardDescription>
        </div>
        {connected ? (
          <Badge variant="secondary" className="gap-1">
            <Check className="h-3 w-3" />
            Connected
          </Badge>
        ) : loggedIn ? (
          <Badge variant="muted">Signed in</Badge>
        ) : (
          <Badge variant="outline">Not connected</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Account</dt>
            <dd className="truncate font-medium">{accountName}</dd>
            <dt className="text-muted-foreground">Project</dt>
            <dd className="truncate font-medium">{projectName}</dd>
            {cloudflare?.baseUrl ? (
              <>
                <dt className="text-muted-foreground">URL</dt>
                <dd className="truncate font-mono text-xs">
                  {cloudflare.baseUrl}
                </dd>
              </>
            ) : null}
          </dl>
        ) : needsAccountChoice ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Choose which Cloudflare account to publish to.
            </p>
            <Select value={chosenAccount} onValueChange={setChosenAccount}>
              <SelectTrigger>
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="w-full"
              disabled={!chosenAccount || selectAccount.isPending}
              onClick={() => selectAccount.mutate(chosenAccount)}
            >
              {selectAccount.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Use this account
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              One click signs in (reusing an existing session when present),
              detects your account, and provisions a Pages project.
            </p>
            <Button
              className="w-full"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting…
                </>
              ) : loggedIn ? (
                "Finish setup"
              ) : (
                "Connect Cloudflare"
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
