"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_OPTIONS = [
  { key: "easy", label: "Easy", icon: "🌱", count: 0 },
  { key: "medium", label: "Medium", icon: "⚡", count: 0 },
  { key: "hard", label: "Hard", icon: "🔥", count: 0 },
];

const STORAGE_KEY = "stellarhunts:puzzle-difficulty";

function normalizeDifficulty(value) {
  const v = String(value || "").toLowerCase();
  if (v === "difficult") return "hard";
  if (v === "easy" || v === "medium" || v === "hard") return v;
  return "easy";
}

export default function PuzzleDifficultySelector({
  puzzles = [],
  value,
  defaultValue = "easy",
  onChange = () => {},
  storageKey = STORAGE_KEY,
  className = "",
}) {
  const options = useMemo(() => {
    const counts = { easy: 0, medium: 0, hard: 0 };
    for (const puzzle of puzzles) {
      const key = normalizeDifficulty(puzzle?.difficulty ?? puzzle?.level);
      if (counts[key] !== undefined) counts[key] += 1;
    }
    return DEFAULT_OPTIONS.map((option) => ({ ...option, count: counts[option.key] }));
  }, [puzzles]);

  const [internal, setInternal] = useState(() => normalizeDifficulty(defaultValue));
  const selected = value !== undefined ? normalizeDifficulty(value) : internal;

  useEffect(() => {
    if (value !== undefined || typeof window === "undefined") return;
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      const normalized = normalizeDifficulty(saved);
      setInternal(normalized);
      onChange(normalized);
    }
  }, [onChange, storageKey, value]);

  const selectDifficulty = (next) => {
    const normalized = normalizeDifficulty(next);
    if (value === undefined) setInternal(normalized);
    if (typeof window !== "undefined") window.localStorage.setItem(storageKey, normalized);
    onChange(normalized);
  };

  return (
    <div className={`w-full ${className}`.trim()}>
      <div
        role="radiogroup"
        aria-label="Puzzle difficulty"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {options.map((option) => {
          const active = selected === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => selectDifficulty(option.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectDifficulty(option.key);
                }
              }}
              className={[
                "group relative rounded-xl border px-4 py-3 text-left transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400",
                active
                  ? "border-purple-400 bg-purple-500/20 shadow-lg shadow-purple-500/10 scale-[1.01]"
                  : "border-white/15 bg-white/5 hover:border-white/30 hover:bg-white/10",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-lg leading-none">
                    {option.icon}
                  </span>
                  <span className="font-medium text-white">{option.label}</span>
                </div>
                <span
                  className={[
                    "rounded-full px-2 py-0.5 text-xs transition-colors duration-200",
                    active ? "bg-purple-400/25 text-purple-100" : "bg-white/10 text-gray-300",
                  ].join(" ")}
                >
                  {option.count}
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-300">
                {option.count === 1 ? "1 puzzle available" : `${option.count} puzzles available`}
              </p>
              <span
                aria-hidden="true"
                className={[
                  "pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-b-xl transition-opacity duration-200",
                  active ? "opacity-100 bg-purple-400" : "opacity-0 bg-white/40",
                ].join(" ")}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
