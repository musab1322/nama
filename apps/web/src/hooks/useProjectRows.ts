"use client";

import { useCallback, useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";

/**
 * Loads rows of a project-scoped table and keeps them live via Supabase Realtime
 * (RLS applies to both the query and the change feed).
 */
export function useProjectRows<T extends { id: string }>(
  table: string,
  projectId: string,
  opts: { select?: string; orderBy?: string; ascending?: boolean; limit?: number; realtime?: boolean; pollMs?: number } = {},
) {
  const { select = "*", orderBy = "created_at", ascending = false, limit = 50, realtime = true, pollMs } = opts;
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { data } = await browserClient()
      .from(table)
      .select(select)
      .eq("project_id", projectId)
      .order(orderBy, { ascending })
      .limit(limit);
    setRows((data as unknown as T[]) ?? []);
    setLoading(false);
  }, [table, projectId, select, orderBy, ascending, limit]);

  useEffect(() => {
    void reload();
    const timer = pollMs ? setInterval(reload, pollMs) : undefined;
    if (!realtime) return () => clearInterval(timer);
    const channel = browserClient()
      // unique per hook instance: two components may watch the same table
      .channel(`${table}:${projectId}:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter: `project_id=eq.${projectId}` }, () => void reload())
      .subscribe();
    return () => {
      clearInterval(timer);
      void browserClient().removeChannel(channel);
    };
  }, [table, projectId, realtime, pollMs, reload]);

  return { rows, loading, reload };
}
