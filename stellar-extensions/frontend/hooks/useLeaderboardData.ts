import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type LeaderboardPeriod = "daily" | "weekly" | "all-time";

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  score: number;
  puzzlesSolved?: number;
  avatarUrl?: string;
}

export interface UseLeaderboardDataOptions {
  period?: LeaderboardPeriod;
  category?: string | null;
  page?: number;
  pageSize?: number;
  refreshIntervalMs?: number;
  cacheTtlMs?: number;
  fetcher?: (params: {
    period: LeaderboardPeriod;
    category: string | null;
    page: number;
    pageSize: number;
    signal: AbortSignal;
  }) => Promise<LeaderboardEntry[]>;
}

interface CacheEntry {
  expiresAt: number;
  data: LeaderboardEntry[];
}

const cache = new Map<string, CacheEntry>();

const defaultFetcher: NonNullable<UseLeaderboardDataOptions["fetcher"]> = async ({
  period,
  category,
  page,
  pageSize,
  signal,
}) => {
  const params = new URLSearchParams({
    period,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (category) params.set("category", category);
  const res = await fetch(`/api/leaderboard?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Failed to fetch leaderboard (${res.status})`);
  const json = await res.json();
  return Array.isArray(json) ? json : (json?.data ?? []);
};

export function useLeaderboardData(options: UseLeaderboardDataOptions = {}) {
  const {
    period = "weekly",
    category = null,
    page = 1,
    pageSize = 10,
    refreshIntervalMs = 60_000,
    cacheTtlMs = 30_000,
    fetcher = defaultFetcher,
  } = options;

  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cacheKey = useMemo(
    () => `${period}|${category ?? ""}|${page}|${pageSize}`,
    [period, category, page, pageSize],
  );

  const load = useCallback(
    async (force = false) => {
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (!force && cached && cached.expiresAt > now) {
        setData(cached.data);
        setLoading(false);
        setError(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const result = await fetcher({ period, category, page, pageSize, signal: controller.signal });
        cache.set(cacheKey, { data: result, expiresAt: Date.now() + cacheTtlMs });
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setError(err as Error);
          setLoading(false);
        }
      }
    },
    [cacheKey, cacheTtlMs, category, fetcher, page, pageSize, period],
  );

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (refreshIntervalMs <= 0) return undefined;
    const id = window.setInterval(() => {
      void load(true);
    }, refreshIntervalMs);
    return () => window.clearInterval(id);
  }, [load, refreshIntervalMs]);

  return {
    data,
    loading,
    error,
    refetch: () => load(true),
    period,
    category,
    page,
    pageSize,
  };
}

export default useLeaderboardData;
