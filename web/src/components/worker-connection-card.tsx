import { useState } from "react";
import { CheckCircle2, Loader2, Server, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useWorkerConnectionAction, useWorkerDisconnectAction, useWorkerHealthAction } from "@/hooks/use-worker-publication";
import type { AppConfig } from "@/lib/types";
import { PAGECAST_WORKER_DEPLOY_URL } from "@/lib/pagecast-worker";

function bindingLabel(state: "ready" | "configured" | "unavailable" | undefined) {
  return state === "ready" ? "ready" : state === "configured" ? "configured" : "unavailable";
}

export function WorkerConnectionCard({ workers }: { workers: AppConfig["workers"] }) {
  const [origin, setOrigin] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [token, setToken] = useState("");
  const [rotating, setRotating] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const connect = useWorkerConnectionAction();
  const health = useWorkerHealthAction();
  const disconnect = useWorkerDisconnectAction();
  const active = workers?.profiles.find((profile) => profile.profileId === workers.activeProfileId) || workers?.profiles[0];

  const saveConnection = () => {
    connect.mutate({ origin, ownerId, token, allowLoopbackHttp: origin.startsWith("http://localhost") || origin.startsWith("http://127.") }, { onSettled: () => setToken("") });
  };

  const rotateCredential = () => {
    if (!active) return;
    connect.mutate({
      origin: active.origin,
      ownerId: active.ownerId,
      token,
      allowLoopbackHttp: active.origin.startsWith("http://localhost") || active.origin.startsWith("http://127.")
    }, {
      onSuccess: () => setRotating(false),
      onSettled: () => setToken("")
    });
  };

  return <Card className="border-zinc-200 shadow-sm"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4" /> Pagecast Worker</CardTitle><CardDescription>Pages remains the default. Connect a Worker only for versioned delivery, access controls, and collaboration.</CardDescription></CardHeader><CardContent className="space-y-3">
    <p className="sr-only" aria-live="polite">{connect.isPending ? "Saving Worker connection" : health.isPending ? "Checking Worker health" : disconnect.isPending ? "Disconnecting Worker" : ""}</p>
    {active ? <div className="rounded-md bg-zinc-50 p-3 text-sm"><div className="flex items-center gap-2 font-medium">{active.verified ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <TriangleAlert className="h-4 w-4 text-amber-600" />}{active.verified ? "Configured and verified" : "Configured; verification unknown"}</div><dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><div>Origin: {active.origin}</div><div>Owner: {active.ownerId}</div><div>Deployment: {active.health?.deployment || "not reported"}</div><div>Environment: {active.health?.environment || "not reported"}</div><div>Hostname: {active.health?.hostname || "not reported"}</div><div>Custom domain: {active.health?.customDomain || "not configured"}</div><div>D1: {bindingLabel(active.health?.bindings.d1)}</div><div>R2: {bindingLabel(active.health?.bindings.r2)}</div><div>Durable Object: {bindingLabel(active.health?.bindings.durableObject)}</div><div>Queue: {bindingLabel(active.health?.bindings.queue)}</div><div>Assets: {bindingLabel(active.health?.bindings.assets)}</div><div>Capabilities: {active.health?.capabilities.join(", ") || "not checked"}</div></dl><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={health.isPending} onClick={() => health.mutate(active.profileId)}>{health.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Verify health</Button><Button size="sm" variant="outline" onClick={() => setRotating((value) => !value)}>Rotate credential</Button><Button size="sm" variant="destructive" disabled={disconnect.isPending} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button></div>{rotating ? <div className="mt-3 grid gap-2 border-t pt-3"><p className="text-xs text-muted-foreground">Replace the local credential for this exact Worker owner and origin. Existing publications keep using this profile.</p><Input value={token} type="password" autoComplete="off" onChange={(event) => setToken(event.target.value)} placeholder="New scoped Worker credential" aria-label="New Worker credential" /><div className="flex gap-2"><Button size="sm" disabled={connect.isPending || !token} onClick={rotateCredential}>{connect.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Save replacement</Button><Button size="sm" variant="ghost" onClick={() => { setToken(""); setRotating(false); }}>Cancel</Button></div></div> : null}</div> : <><p className="text-sm text-muted-foreground">Worker deployment is an external operator setup step. Deploy it first, then enter a scoped credential. The credential is sent once to local secure storage and immediately cleared from this form.</p><Button size="sm" variant="outline" asChild><a href={PAGECAST_WORKER_DEPLOY_URL} target="_blank" rel="noreferrer">Deploy Pagecast Worker</a></Button><div className="grid gap-2 sm:grid-cols-2"><Input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://your-worker.workers.dev" aria-label="Worker origin" /><Input value={ownerId} onChange={(event) => setOwnerId(event.target.value)} placeholder="Owner ID" aria-label="Worker owner ID" /></div><Input value={token} type="password" autoComplete="off" onChange={(event) => setToken(event.target.value)} placeholder="Scoped Worker credential" aria-label="Worker credential" /><Button disabled={connect.isPending || !origin || !ownerId || !token} onClick={saveConnection}>{connect.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Connect Worker</Button></>}
    <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Disconnect this Worker?</AlertDialogTitle><AlertDialogDescription>Local credentials for this Worker profile will be removed. Existing Worker publications are not deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep connected</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => active && disconnect.mutate(active.profileId)}>Disconnect</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
