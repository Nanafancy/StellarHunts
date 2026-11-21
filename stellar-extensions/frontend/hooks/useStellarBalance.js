"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Horizon endpoints for the networks StellarHunts supports. Set
 * NEXT_PUBLIC_HORIZON_URL to point at a custom or proxied Horizon instance.
 */
const HORIZON_URLS = {
  "Public Global Stellar Network ; September 2015":
    "https://horizon.stellar.org",
  "Test SDF Network ; September 2015": "https://horizon-testnet.stellar.org",
};

/**
 * Resolve the Horizon base URL for a network passphrase.
 *
 * @param {string|null|undefined} network
 * @returns {string|null}
 */
export function getHorizonUrl(network) {
  if (process.env.NEXT_PUBLIC_HORIZON_URL) {
    return process.env.NEXT_PUBLIC_HORIZON_URL;
  }
  return HORIZON_URLS[network] || null;
}

/**
 * Load the native XLM balance for `address` on `network`.
 *
 * Returns the Horizon balance as a string (Stellar amounts are decimal
 * strings), plus loading/error state and a `refresh` callback so the widget
 * can retry after a network switch or a failed request.
 *
 * @param {string|null} address
 * @param {string|null} network - Stellar network passphrase
 */
export function useStellarBalance(address, network) {
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    const horizonUrl = getHorizonUrl(network);
    if (!horizonUrl) {
      setBalance(null);
      setError("Balance is unavailable for this network.");
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;

    setLoading(true);
    setError(null);

    fetch(`${horizonUrl}/accounts/${address}`, {
      signal: controller?.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "Account is not funded on this network."
              : `Could not load balance (HTTP ${response.status}).`,
          );
        }
        return response.json();
      })
      .then((account) => {
        if (cancelled) return;
        const native = (account.balances || []).find(
          (entry) => entry.asset_type === "native",
        );
        setBalance(native ? native.balance : "0");
      })
      .catch((err) => {
        if (cancelled || err?.name === "AbortError") return;
        setBalance(null);
        setError(err?.message || "Could not load balance.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [address, network, reloadToken]);

  return { balance, loading, error, refresh };
}

export default useStellarBalance;
