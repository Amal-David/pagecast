import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import { useWorkerAction } from "@/hooks/use-worker-publication";
import type { AppConfig, Report } from "@/lib/types";

export function DeliveryPicker({ report, workers }: { report: Report; workers: AppConfig["workers"] }) {
  const pages = report.publications.filter((publication) => publication.backend === "pages");
  const worker = report.publications.find((publication) => publication.backend === "workers");
  const [selectedToken, setSelectedToken] = useState(pages[0]?.token || "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState(false);
  const selected = useMemo(() => pages.find((publication) => publication.token === selectedToken), [pages, selectedToken]);
  const connected = Boolean(workers?.profiles.length);
  const migrate = useWorkerAction(selected?.token || "", () => api.migrateToWorker(selected!.token, report.passwordProtected ? password : undefined), "Worker delivery created. The Pages URL remains live.");
  const canConfirm = Boolean(selected && (!report.passwordProtected || password.length >= 12));
  return <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm" aria-label="Delivery selection"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-semibold">Delivery</p><p className="text-xs text-muted-foreground">Cloudflare Pages is the default. Worker delivery is an explicit opt-in.</p></div><Badge variant="outline">{worker ? "Worker active" : "Pages default"}</Badge></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><div className={`rounded-md border p-3 ${!worker ? "border-zinc-900" : ""}`}><p className="font-medium text-sm">Cloudflare Pages</p><p className="mt-1 text-xs text-muted-foreground">Existing links and deployment history stay here.</p>{pages.length > 1 ? <label className="mt-3 block text-xs font-medium">Pages publication<select className="mt-1 h-8 w-full rounded border px-2" value={selectedToken} onChange={(event) => setSelectedToken(event.target.value)}>{pages.map((publication) => <option key={publication.token} value={publication.token}>{publication.label || publication.slug}</option>)}</select></label> : null}</div><div className={`rounded-md border p-3 ${worker ? "border-zinc-900" : ""}`}><p className="font-medium text-sm">Pagecast Worker</p><p className="mt-1 text-xs text-muted-foreground">Versioned delivery, access controls, and collaboration.</p>{selected ? <p className="mt-2 text-xs text-muted-foreground">Preserves {selected.drop ? "public drop" : "unlisted"} link kind and {selected.expiresAt ? "the existing expiry" : "no expiry"}.</p> : null}{selected ? <Button className="mt-3" size="sm" variant="outline" disabled={!connected || migrate.isPending} onClick={() => setConfirm(true)}>{connected ? "Choose Worker delivery" : "Connect a Worker first"}</Button> : null}</div></div><AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Create Worker delivery?</AlertDialogTitle><AlertDialogDescription>The Pages URL remains live for recovery. The new Worker publication is attached to this same report.</AlertDialogDescription></AlertDialogHeader>{report.passwordProtected ? <div className="space-y-2"><Label htmlFor="worker-migration-password">New Worker password</Label><Input id="worker-migration-password" type="password" minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><p className="text-xs text-muted-foreground">Protected Pages publications require a new password with at least 12 characters.</p></div> : null}<AlertDialogFooter><AlertDialogCancel>Keep Pages</AlertDialogCancel><AlertDialogAction disabled={!canConfirm} onClick={() => migrate.mutate(undefined)}>Create Worker delivery</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></section>;
}
