import { useEffect } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import { BarChart3, Eye, Loader2 } from "lucide-react";
import { useFeedbackStats } from "@/hooks/use-pagecast";
import type { FeedbackStats } from "@/lib/types";

// Animate a number from 0 to value when it changes.
function CountUp({ value }: { value: number }) {
  const reduceMotion = useReducedMotion();
  const mv = useMotionValue(reduceMotion ? value : 0);
  const rounded = useTransform(mv, (v) => Math.round(v));
  useEffect(() => {
    if (reduceMotion) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.7, ease: "easeOut" });
    return () => controls.stop();
  }, [value, reduceMotion, mv]);
  return <motion.span>{rounded}</motion.span>;
}

// Map ISO country codes to a flag emoji; falls back to the raw code.
function flag(code: string) {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🌐";
  const base = 0x1f1e6;
  const cc = code.toUpperCase();
  return String.fromCodePoint(base + cc.charCodeAt(0) - 65, base + cc.charCodeAt(1) - 65);
}

function topEntries(map: Record<string, number> | undefined, limit = 4) {
  return Object.entries(map ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function Breakdown({
  title,
  entries,
  label
}: {
  title: string;
  entries: [string, number][];
  label: (key: string) => string;
}) {
  const max = entries.reduce((m, [, n]) => Math.max(m, n), 0) || 1;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No data yet.</p>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, n], index) => (
            <div key={key} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-xs">{label(key)}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <motion.div
                  className="h-full rounded-full bg-foreground/70"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.round((n / max) * 100)}%` }}
                  transition={{
                    type: "spring",
                    stiffness: 120,
                    damping: 20,
                    delay: 0.05 * index
                  }}
                />
              </div>
              <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {n}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FeedbackStatsPanel({
  slug,
  enabled
}: {
  slug: string | null;
  enabled: boolean;
}) {
  const query = useFeedbackStats(slug, enabled);

  if (!enabled || !slug) return null;

  const stats = (query.data?.stats ?? null) as FeedbackStats | null;
  const totalReactions = Object.values(stats?.reactions ?? {}).reduce((a, b) => a + b, 0);

  return (
    <section className="rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Audience</h3>
        </div>
        {query.isFetching ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading stats…</div>
      ) : !stats || stats.views === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No views yet. Share the link — stats appear here as people open it.
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <span className="text-2xl font-semibold tabular-nums">
                <CountUp value={stats.views} />
              </span>
              <span className="text-xs text-muted-foreground">views</span>
            </div>
            {totalReactions > 0 ? (
              <div className="flex items-center gap-1.5">
                {Object.entries(stats.reactions)
                  .filter(([, n]) => n > 0)
                  .map(([emoji, n]) => (
                    <motion.span
                      key={emoji}
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 500, damping: 18 }}
                      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                    >
                      {emoji} {n}
                    </motion.span>
                  ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Breakdown
              title="Top countries"
              entries={topEntries(stats.countries)}
              label={(k) => `${flag(k)} ${k}`}
            />
            <Breakdown
              title="Referrers"
              entries={topEntries(stats.referrers)}
              label={(k) => k}
            />
            <Breakdown
              title="Devices"
              entries={topEntries(stats.devices)}
              label={(k) => k}
            />
          </div>
        </div>
      )}
    </section>
  );
}
