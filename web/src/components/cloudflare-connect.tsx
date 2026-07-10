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
import { Switch } from "@/components/ui/switch";
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
  useCloudflareProject,
  useCloudflareProjects,
  useCloudflareLogout
} from "@/hooks/use-cloudflare";
import { useSyncCloudflarePages } from "@/hooks/use-pagecast";
import {
  cloudflareProjectDomain as projectDomain,
  cloudflareProjectLabel as projectOptionLabel,
  cloudflareProjectValue as projectOptionValue,
  getCloudflareProjectSelection
} from "@/lib/cloudflare";
import type { CloudflareStatus } from "@/lib/types";

interface CloudflareConnectProps {
  cloudflare: CloudflareStatus | undefined;
  autoSyncEnabled: boolean;
  autoSyncPending: boolean;
  onToggleAutoSync: (enabled: boolean) => void;
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

export function CloudflareConnect({
  cloudflare,
  autoSyncEnabled,
  autoSyncPending,
  onToggleAutoSync
}: CloudflareConnectProps) {
  const connect = useCloudflareConnect();
  const selectAccount = useCloudflareAccount();
  const selectProject = useCloudflareProject();
  const syncCloudflare = useSyncCloudflarePages();
  const logout = useCloudflareLogout();
  const [chosenAccount, setChosenAccount] = useState<string>("");
  const [chosenProject, setChosenProject] = useState<string>("");

  const loggedIn = Boolean(cloudflare?.loggedIn);
  const accounts = cloudflare?.accounts ?? [];
  const projectsQuery = useCloudflareProjects(loggedIn);
  const projects = projectsQuery.data?.cloudflare.projects ?? [];
  const accountName = displayAccountName(cloudflare);
  const projectName = cloudflare?.projectName ?? "";
  const tokenAuth = cloudflare?.authMode === "api-token";
  const selectedAccountId = cloudflare?.accountId || "";
  const requiresAdoption = cloudflare?.requiresAdoption === true;
  const canChooseAccount = loggedIn && accounts.length > 1;
  const configured = loggedIn && Boolean(accountName) && Boolean(projectName);
  const connected = configured && !requiresAdoption;
  const { selectedProjectValue, displayedProjects } = getCloudflareProjectSelection(
    projects,
    projectName,
    selectedAccountId
  );
  const effectiveChosenProject = chosenProject || selectedProjectValue;
  const chosenProjectRecord = projects.find(
    (project) => projectOptionValue(project) === effectiveChosenProject
  );
  const canChooseProject = loggedIn && projects.length > 0;

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
        {requiresAdoption ? (
          <Badge variant="outline">Adoption required</Badge>
        ) : connected ? (
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
        {configured ? (
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

            {requiresAdoption ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                This existing project is selected but not managed by this workspace.
                Confirm <strong>Adopt</strong> below before Pagecast changes its published files.
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-3">
              <div>
                <p className="text-sm font-medium">Sync from Cloudflare</p>
                <p className="text-xs text-muted-foreground">
                  {autoSyncEnabled
                    ? "Automatically imports missing published links."
                    : "Manual sync only."}
                </p>
              </div>
              <Switch
                checked={autoSyncEnabled}
                disabled={autoSyncPending}
                onCheckedChange={onToggleAutoSync}
                aria-label="Toggle Cloudflare auto-sync"
              />
            </div>

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

            {canChooseProject ? (
              <div className="space-y-3 border-t pt-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Select
                    value={chosenProject || selectedProjectValue}
                    onValueChange={setChosenProject}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a Pages project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={projectOptionValue(project)} value={projectOptionValue(project)}>
                          {projectOptionLabel(project)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    disabled={
                      !chosenProjectRecord ||
                      (effectiveChosenProject === selectedProjectValue && !requiresAdoption) ||
                      selectProject.isPending ||
                      syncCloudflare.isPending
                    }
                    onClick={() =>
                      chosenProjectRecord &&
                      selectProject.mutate(chosenProjectRecord, {
                        onSuccess: () => syncCloudflare.mutate({})
                      })
                    }
                  >
                    {selectProject.isPending || syncCloudflare.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    {effectiveChosenProject === selectedProjectValue && requiresAdoption
                      ? "Adopt"
                      : "Switch"}
                  </Button>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Cloudflare Pages projects</p>
                    <Badge variant="muted">{projects.length}</Badge>
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-md border">
                    {displayedProjects.map((project) => {
                      const value = projectOptionValue(project);
                      const isCurrent = value === selectedProjectValue;
                      const canAdopt = isCurrent && requiresAdoption;
                      return (
                        <div
                          key={value}
                          className="grid gap-2 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center"
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <p className="truncate text-sm font-medium">{project.name}</p>
                              {isCurrent ? (
                                <Badge variant="secondary" className="shrink-0 gap-1">
                                  <Check className="h-3 w-3" />
                                  Current
                                </Badge>
                              ) : null}
                            </div>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {projectDomain(project)}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={isCurrent ? "secondary" : "outline"}
                            disabled={
                              (isCurrent && !canAdopt) ||
                              selectProject.isPending ||
                              syncCloudflare.isPending
                            }
                            onClick={() =>
                              selectProject.mutate(project, {
                                onSuccess: () => syncCloudflare.mutate({})
                              })
                            }
                          >
                            {isCurrent && !canAdopt ? (
                              <Check className="h-4 w-4" />
                            ) : selectProject.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : null}
                            {canAdopt ? "Adopt" : isCurrent ? "Current" : "Use"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : projectsQuery.isLoading && loggedIn ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading Pages projects
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
              Connect the account you want Pagecast to use for publishing. It's
              free — Pagecast publishes to your own Cloudflare Pages.
            </p>
            <Button
              className="w-full"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Waiting for Cloudflare…
                </>
              ) : loggedIn ? (
                "Finish setup"
              ) : (
                "Connect Cloudflare"
              )}
            </Button>
            {connect.isPending ? (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                A Cloudflare login tab just opened in your browser. Approve access
                there, then come back here — this finishes automatically.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Opens a Cloudflare login tab in your browser. Pagecast only
                requests the scopes it needs to create and deploy your Pages
                project.
              </p>
            )}
            {connect.isError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                That didn't complete. Make sure you approved access in the
                Cloudflare tab, then try again.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
