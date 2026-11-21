"use client";

import { useMemo, useState } from "react";

const CODE_PATTERN = /^[A-Z0-9_-]{4,32}$/;

export default function PromoCodeInput({
  onValidate,
  onClaim,
  maxAttempts = 5,
  className = "",
}) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [reward, setReward] = useState(null);
  const [attempts, setAttempts] = useState(0);

  const normalizedCode = useMemo(() => code.toUpperCase().replace(/\s+/g, ""), [code]);
  const rateLimited = attempts >= maxAttempts;

  const handleChange = (e) => {
    setCode(e.target.value.toUpperCase());
    if (status !== "idle") {
      setStatus("idle");
      setMessage("");
      setReward(null);
    }
  };

  const handleValidate = async () => {
    if (rateLimited) {
      setStatus("error");
      setMessage("Too many attempts. Please try again later.");
      return;
    }
    if (!CODE_PATTERN.test(normalizedCode)) {
      setStatus("error");
      setMessage("Enter a valid promo code (4-32 letters, numbers, _ or -).");
      return;
    }

    setStatus("loading");
    setMessage("");
    setReward(null);
    try {
      const result = onValidate ? await onValidate(normalizedCode) : { valid: false };
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);
      if (result?.valid) {
        setStatus("valid");
        setReward(result.reward || { title: "Reward unlocked", description: "You can claim this reward now." });
        setMessage("Promo code accepted.");
      } else {
        setStatus("invalid");
        setMessage(result?.message || "Invalid or expired promo code.");
        if (nextAttempts >= maxAttempts) {
          setMessage("Invalid code. Too many attempts, please try again later.");
        }
      }
    } catch (err) {
      setAttempts((a) => a + 1);
      setStatus("error");
      setMessage(err?.message || "Could not validate the code. Please try again.");
    }
  };

  const handleClaim = async () => {
    if (status !== "valid" || !reward) return;
    setStatus("claiming");
    try {
      if (onClaim) await onClaim(normalizedCode, reward);
      setStatus("claimed");
      setMessage("Reward claimed successfully.");
    } catch (err) {
      setStatus("valid");
      setMessage(err?.message || "Claim failed. Please try again.");
    }
  };

  return (
    <div className={`rounded-xl border border-white/15 bg-white/5 p-4 text-white ${className}`.trim()}>
      <label htmlFor="promo-code-input" className="block text-sm font-medium text-gray-200">
        Promo Code
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="promo-code-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          value={normalizedCode}
          onChange={handleChange}
          placeholder="ENTER-CODE"
          maxLength={32}
          className="w-full rounded-lg border border-white/20 bg-black/20 px-3 py-2 uppercase tracking-wide text-white placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          aria-describedby="promo-code-feedback"
        />
        <button
          type="button"
          onClick={handleValidate}
          disabled={status === "loading" || status === "claiming" || rateLimited}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          {status === "loading" ? "Validating..." : "Validate"}
        </button>
      </div>

      <div id="promo-code-feedback" className="mt-3 min-h-6 text-sm" aria-live="polite">
        {message && (
          <p
            className={
              status === "valid" || status === "claimed"
                ? "text-emerald-300"
                : status === "invalid" || status === "error"
                  ? "text-red-300"
                  : "text-gray-300"
            }
          >
            {message}
          </p>
        )}
        {rateLimited && status !== "error" && (
          <p className="text-amber-300">Rate limit reached. Too many attempts.</p>
        )}
      </div>

      {reward && (status === "valid" || status === "claiming" || status === "claimed") && (
        <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3">
          <p className="text-sm font-medium text-emerald-200">{reward.title || "Reward preview"}</p>
          {reward.description && <p className="mt-1 text-xs text-emerald-100/90">{reward.description}</p>}
          {status !== "claimed" ? (
            <button
              type="button"
              onClick={handleClaim}
              disabled={status === "claiming"}
              className="mt-3 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              {status === "claiming" ? "Claiming..." : "Claim Reward"}
            </button>
          ) : (
            <p className="mt-3 text-sm font-medium text-emerald-200">✓ Reward claimed</p>
          )}
        </div>
      )}
    </div>
  );
}
