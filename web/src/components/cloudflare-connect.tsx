import { useState } from "react";
import { Check, Cloud, LogOut, Loader2 } from "lucide-react";
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
  useCloudflareConnect,
  useCloudflareLogout
} from "@/hooks/use-cloudflare";
import type { CloudflareStatus } from "@/lib/types";

interface CloudflareConnectProps {
  cloudflare: CloudflareStatus | undefined;
}

function displayAccountName(cloudflare: CloudflareStatus | undefined) {
  const name = cloudflare?.accountName || "";
  if (name.trim() && !/^\(?redacted\)?$/i.test(name.trim())) {
    return name;
  }
  return cloudflare?.loggedIn || cloudflare?.accountId ? "Cloudflare account" : "";
}

function accountOptionLabel(account: { name?: string; id: string }, index: number) {
  const name = account.name || "";
  if (name.trim() && !/^\(?redacted\)?$/i.test(name.trim())) {
    return name;
  }
  return `Cloudflare account ${index + 1}`;
}

export function CloudflareConnect({ cloudflare }: CloudflareConnectProps) {
  const connect = useCloudflareConnect();
  const selectAccount = useCloudflareAccount();
  const logout = useCloudflareLogout();
  const [chosenAccount, setChosenAccount] = useState<string>("");

  const loggedIn = Boolean(cloudflare?.loggedIn);
  const accounts = cloudflare?.accounts ?? [];
  const accountName = displayAccountName(cloudflare);
  const projectName = cloudflare?.projectName ?? "";
  const tokenAuth = cloudflare?.authMode === "api-token";
  const selectedAccountId = cloudflare?.accountId || "";
  const canChooseAccount = loggedIn && accounts.length > 1;
  const connected = loggedIn && Boolean(accountName) && Boolean(projectName);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4" />
            Publishing account
          </CardTitle>
          <CardDescription>
            Sign in once, then publish pages from this workspace.
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
          <div className="space-y-3">
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

            {canChooseAccount ? (
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Select
                  value={chosenAccount || selectedAccountId}
                  onValueChange={setChosenAccount}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account, index) => (
                      <SelectItem key={account.id} value={account.id}>
                        {accountOptionLabel(account, index)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={
                    !chosenAccount ||
                    chosenAccount === selectedAccountId ||
                    selectAccount.isPending
                  }
                  onClick={() => selectAccount.mutate(chosenAccount)}
                >
                  {selectAccount.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Switch
                </Button>
              </div>
            ) : null}

            <Button
              variant="outline"
              className="w-full justify-start"
              disabled={logout.isPending || tokenAuth}
              onClick={() => logout.mutate()}
            >
              {logout.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              {tokenAuth ? "Token auth managed by environment" : "Log out"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect the account you want Pagecast to use for publishing.
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
