"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = String(Math.floor(safe / 60)).padStart(2, "0");
  const seconds = String(safe % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function PuzzleTimerAndStats({
  mode = "live",
  initialSeconds = 0,
  countdownSeconds = 120,
  running = true,
  completed = false,
  hintsUsed = 0,
  attempts = 0,
  bestTimeSeconds = null,
  onTimeChange = () => {},
  onComplete = () => {},
  className = "",
}) {
  const isCountdown = mode === "countdown";
  const [elapsed, setElapsed] = useState(Math.max(0, initialSeconds));
  const [remaining, setRemaining] = useState(Math.max(0, countdownSeconds));
  const [paused, setPaused] = useState(false);
  const completedRef = useRef(false);

  useEffect(() => {
    setElapsed(Math.max(0, initialSeconds));
  }, [initialSeconds]);

  useEffect(() => {
    setRemaining(Math.max(0, countdownSeconds));
    completedRef.current = false;
  }, [countdownSeconds]);

  useEffect(() => {
    if (!running || completed || (!isCountdown && paused)) return undefined;
    const id = window.setInterval(() => {
      if (isCountdown) {
        setRemaining((prev) => {
          const next = Math.max(0, prev - 1);
          if (next === 0 && !completedRef.current) {
            completedRef.current = true;
            onComplete();
          }
          return next;
        });
      } else {
        setElapsed((prev) => {
          const next = prev + 1;
          onTimeChange(next);
          return next;
        });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [completed, isCountdown, onComplete, onTimeChange, paused, running]);

  const displaySeconds = isCountdown ? remaining : elapsed;
  const lowTime = isCountdown && remaining <= 10 && remaining > 0;
  const timerColor = lowTime ? "text-red-400" : "text-emerald-300";
  const canPause = !isCountdown && !completed;

  const stats = useMemo(
    () => [
      { label: "Time Taken", value: formatTime(isCountdown ? Math.max(0, countdownSeconds - remaining) : elapsed) },
      { label: "Hints Used", value: String(hintsUsed) },
      { label: "Attempts", value: String(attempts) },
      { label: "Best Time", value: bestTimeSeconds == null ? "--:--" : formatTime(bestTimeSeconds) },
    ],
    [attempts, bestTimeSeconds, countdownSeconds, elapsed, hintsUsed, isCountdown, remaining],
  );

  return (
    <div className={`rounded-xl border border-white/15 bg-white/5 p-4 text-white ${className}`.trim()}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400">
            {isCountdown ? "Time Trial" : "Puzzle Timer"}
          </p>
          <p
            className={`mt-1 text-3xl font-semibold tabular-nums transition-colors duration-300 ${timerColor}`}
            aria-live="polite"
            aria-atomic="true"
          >
            {formatTime(displaySeconds)}
          </p>
          <p className="sr-only" aria-live="polite">
            {isCountdown ? `${remaining} seconds remaining` : `${elapsed} seconds elapsed`}
          </p>
        </div>
        {canPause && (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="rounded-lg border border-white/20 px-3 py-2 text-sm transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            aria-pressed={paused}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        )}
      </div>

      {completed && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Puzzle statistics">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg bg-black/20 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-gray-400">{stat.label}</p>
              <p className="mt-1 text-sm font-medium text-gray-100">{stat.value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
