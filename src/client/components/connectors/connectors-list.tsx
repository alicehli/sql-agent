import { useEffect, useState } from "react";

interface Connector {
  id: number;
  name: string;
  type: string;
}

// Small color hint per backend family so the list is scannable.
function typeClasses(type: string): string {
  const t = type.toUpperCase();
  if (t.includes("SNOWFLAKE")) return "bg-sky-100 text-sky-700";
  if (t.includes("BIGQUERY")) return "bg-blue-100 text-blue-700";
  if (t.includes("REDSHIFT")) return "bg-red-100 text-red-700";
  if (t.includes("POSTGRES") || t.includes("AURORA") || t.includes("SUPABASE"))
    return "bg-indigo-100 text-indigo-700";
  if (t.includes("KDB")) return "bg-amber-100 text-amber-700";
  if (t.includes("TABLEAU") || t.includes("POWERBI"))
    return "bg-purple-100 text-purple-700";
  return "bg-muted text-muted-foreground";
}

export function ConnectorsList() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/connectors")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: Connector[]) => {
        if (!cancelled) {
          setConnectors(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e instanceof Error ? e.message : e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex max-h-[40%] shrink-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connectors
        </span>
        {!loading && !error && (
          <span className="text-xs text-muted-foreground">
            {connectors.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {error && (
          <div className="px-3 py-2 text-xs text-red-600">
            Failed to load connectors
          </div>
        )}
        {!loading && !error && connectors.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No connectors
          </div>
        )}
        {!loading &&
          !error &&
          connectors.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50"
              title={`${c.name} · ${c.type} · id ${c.id}`}
            >
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${typeClasses(
                  c.type,
                )}`}
              >
                {c.type}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
