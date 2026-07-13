import { useMemo, useState } from "react";
import { Activity, Eye, Loader2, ShieldCheck, Users } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAnalyticsEvents, useAnalyticsSummary } from "@/hooks/use-pagecast";
import { relativeTime } from "@/lib/format";
import type { Publication, Report } from "@/lib/types";

export function PublicationActivitySummary({ publicationId, enabled }: { publicationId: string; enabled: boolean }) {
  const query = useAnalyticsSummary(publicationId, enabled);
  if (!enabled) return null;
  const summary = query.data?.summaries?.[0];
  return (
    <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground" aria-label="Link activity summary">
      {query.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
      <span>{Number(summary?.views || 0)} views</span>
      <span>{Number(summary?.uniqueVisitors || 0)} anonymous unique</span>
      <span>{summary?.lastAccessAt ? `Last access ${relativeTime(summary.lastAccessAt)}` : "No access yet"}</span>
    </div>
  );
}

export function ActivityPanel({ publications, enabled, global = false }: { publications: Publication[]; enabled: boolean; global?: boolean }) {
  const active = publications.filter((publication) => publication.active);
  const [selected, setSelected] = useState(global ? "all" : active[0]?.token || "all");
  const publicationId = selected === "all" ? null : selected;
  const summary = useAnalyticsSummary(publicationId, enabled);
  const events = useAnalyticsEvents(publicationId, enabled);
  const totals = useMemo(() => {
    const rows = summary.data?.summaries || [];
    return rows.reduce((acc, row) => ({ views: acc.views + Number(row.views || 0), unique: acc.unique + Number(row.uniqueVisitors || 0) }), { views: 0, unique: 0 });
  }, [summary.data]);

  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-muted-foreground" /><h3 className="text-sm font-semibold">Activity</h3></div>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Activity link selector"><SelectValue /></SelectTrigger>
          <SelectContent>
            {global ? <SelectItem value="all">All Pagecast links</SelectItem> : null}
            {active.map((publication) => <SelectItem key={publication.token} value={publication.token}>{publication.label || publication.slug}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {!enabled ? (
        <div className="p-5 text-sm text-muted-foreground">Enable private, cookieless analytics to see access activity.</div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric icon={Eye} label="Views" value={totals.views} />
            <Metric icon={Users} label="Anonymous unique" value={totals.unique} />
            <Metric icon={ShieldCheck} label="Retention" value="30 days" />
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2">Access</th><th className="p-2">Visitor</th><th className="p-2">Country</th><th className="p-2">Region / city</th><th className="p-2">ASN / organization</th><th className="p-2">Device</th><th className="p-2">Referrer</th></tr></thead>
              <tbody className="divide-y">
                {(events.data?.events || []).map((event) => <tr key={event.eventId}><td className="p-2 whitespace-nowrap">{relativeTime(event.occurredAt)}</td><td className="p-2 font-mono">{event.visitorId.slice(0, 10)}…</td><td className="p-2">{event.country || "XX"}</td><td className="p-2">{[event.region, event.city].filter(Boolean).join(" / ") || "—"}</td><td className="p-2">{[event.asn, event.organization].filter(Boolean).join(" / ") || "—"}</td><td className="p-2">{event.device}</td><td className="p-2">{event.referrerHostname || "direct"}</td></tr>)}
                {events.isLoading ? <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Loading activity…</td></tr> : null}
                {!events.isLoading && (events.data?.events.length || 0) === 0 ? <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No access events yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            <strong className="text-foreground">Unlisted link:</strong> anyone with the URL can open it. <strong className="text-foreground">Password protected:</strong> Pagecast-enforced access control. Analytics provides audit visibility, not visitor identity or prevention. Raw IP addresses are never stored.
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Eye; label: string; value: number | string }) {
  return <div className="rounded-md border bg-muted/20 p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div></div>;
}

export function GlobalActivity({ reports, enabled }: { reports: Report[]; enabled: boolean }) {
  const publications = reports.flatMap((report) => report.publications);
  return <div className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-6xl space-y-3"><div><h2 className="text-xl font-semibold">All Pagecast activity</h2><p className="text-sm text-muted-foreground">Access activity across every Home page and link.</p></div><ActivityPanel publications={publications} enabled={enabled} global /></div></div>;
}
