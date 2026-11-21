"use client";

import { useMemo, useState } from "react";

export default function PuzzleCategoryNavigationSidebar({
  categories = [],
  activeCategoryId = null,
  onSelect = () => {},
  isLoading = false,
  error = null,
  className = "",
}) {
  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => String(c?.name || "").toLowerCase().includes(q));
  }, [categories, query]);

  const handleSelect = (category) => {
    onSelect(category);
    setMobileOpen(false);
  };

  const content = (
    <div className="space-y-3">
      <div>
        <label htmlFor="puzzle-category-search" className="sr-only">
          Search categories
        </label>
        <input
          id="puzzle-category-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search categories"
          className="w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        />
      </div>

      {isLoading && <p className="px-1 text-sm text-gray-400">Loading categories...</p>}
      {error && !isLoading && (
        <p role="alert" className="px-1 text-sm text-red-300">
          Could not load categories.
        </p>
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <p className="px-1 text-sm text-gray-400">No categories found.</p>
      )}

      <ul className="space-y-2" aria-label="Puzzle categories">
        {filtered.map((category) => {
          const id = category.id ?? category.slug ?? category.name;
          const active = id === activeCategoryId;
          const total = Number(category.totalPuzzles ?? category.count ?? 0);
          const completed = Math.min(Number(category.completedPuzzles ?? 0), total);
          const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => handleSelect(category)}
                aria-current={active ? "page" : undefined}
                className={[
                  "w-full rounded-xl border px-3 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400",
                  active
                    ? "border-purple-400 bg-purple-500/20"
                    : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10",
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {category.icon ? <span aria-hidden="true">{category.icon}</span> : null}
                      <span className="truncate text-sm font-medium text-white">{category.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-300">
                      <span className="rounded-full bg-white/10 px-2 py-0.5">{total} puzzles</span>
                      {category.difficulty ? (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 capitalize">
                          {category.difficulty}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className="text-xs text-gray-300">{progress}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-purple-400 transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="sr-only">{progress}% completed</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <aside className={`w-full md:w-72 ${className}`.trim()} aria-label="Puzzle category navigation">
      <button
        type="button"
        className="mb-2 w-full rounded-lg border border-white/20 px-4 py-2 text-left text-sm text-white md:hidden"
        aria-expanded={mobileOpen}
        aria-controls="puzzle-category-nav-panel"
        onClick={() => setMobileOpen((v) => !v)}
      >
        {mobileOpen ? "Hide categories" : "Show categories"}
      </button>
      <div
        id="puzzle-category-nav-panel"
        className={`${mobileOpen ? "block" : "hidden"} rounded-xl border border-white/10 bg-white/5 p-3 md:block`}
      >
        {content}
      </div>
    </aside>
  );
}
