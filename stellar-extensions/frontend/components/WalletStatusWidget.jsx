"use client";

import { useEffect, useRef, useState } from "react";
import { Networks } from "@stellar/stellar-sdk";

import { useStellarBalance } from "../hooks/useStellarBalance";

const NETWORK_LABELS = {
  [Networks.PUBLIC]: "Mainnet",
  [Networks.TESTNET]: "Testnet",
  [Networks.FUTURENET]: "Futurenet",
};

const STATUS_LABELS = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Not connected",
  error: "Connection issue",
};

/**
 * Human-readable label for a Stellar network passphrase.
 */
export function getNetworkLabel(network) {
  if (!network) return "Unknown network";
  return NETWORK_LABELS[network] || network;
}

/**
 * Shorten a Stellar public key for display, e.g. GABCD...WXYZ.
 */
export function shortenAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Format a Horizon balance (decimal string) for display.
 */
export function formatBalance(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString("en-US", { maximumFractionDigits: 7 });
}

/**
 * WalletStatusWidget
 * ------------------
 * Compact wallet status card (#904) showing:
 *  - truncated address with a copy button
 *  - the connected network (with a mismatch warning banner)
 *  - the Stellar (XLM) balance, loaded from Horizon when not supplied
 *  - a disconnect button
 *  - disconnected, connecting and error states
 *
 * The widget is presentational: it receives the wallet session from the host
 * (for example the existing `useWalletConnection` hook) so it can be dropped
 * into any page without duplicating wallet lifecycle logic.
 *
 * @param {object} props
 * @param {string|null} [props.address]
 * @param {string} [props.status] - "connected" | "connecting" | "disconnected" | "error"
 * @param {string|null} [props.network] - current network passphrase
 * @param {string|null} [props.expectedNetwork] - required network passphrase
 * @param {string|null} [props.error] - connection error to surface
 * @param {string|null} [props.balance] - XLM balance override; fetched when undefined
 * @param {boolean} [props.balanceLoading]
 * @param {string|null} [props.balanceError]
 * @param {Function} [props.onConnect]
 * @param {Function} [props.onDisconnect]
 * @param {Function} [props.onRefreshBalance]
 * @param {Function} [props.onSwitchNetwork]
 * @param {boolean} [props.canSwitchNetwork]
 */
export default function WalletStatusWidget({
  address = null,
  status = "disconnected",
  network = null,
  expectedNetwork = null,
  error = null,
  balance,
  balanceLoading,
  balanceError,
  onConnect,
  onDisconnect,
  onRefreshBalance,
  onSwitchNetwork,
  canSwitchNetwork = false,
  className = "",
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  // Only fetch when the host does not provide a balance.
  const fetched = useStellarBalance(balance === undefined ? address : null, network);
  const displayedBalance = balance !== undefined ? balance : fetched.balance;
  const isLoadingBalance =
    balanceLoading !== undefined ? balanceLoading : fetched.loading;
  const displayedBalanceError =
    balanceError !== undefined ? balanceError : fetched.error;
  const refreshBalance = onRefreshBalance || fetched.refresh;

  const isConnected = Boolean(address);
  const isConnecting = status === "connecting";
  const mismatched =
    isConnected && Boolean(network) && Boolean(expectedNetwork) && network !== expectedNetwork;

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!address || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const formattedBalance = formatBalance(displayedBalance);

  return (
    <section
      aria-label="Wallet status"
      className={`w-full rounded-xl border border-neutral-200 bg-white p-4 text-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 rounded-full ${
              isConnected
                ? "bg-emerald-500"
                : isConnecting
                  ? "animate-pulse bg-amber-400"
                  : "bg-neutral-400"
            }`}
          />
          <span className="font-medium text-neutral-900 dark:text-neutral-100">
            {STATUS_LABELS[status] || STATUS_LABELS.disconnected}
          </span>
        </div>

        <span
          className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          title={network || undefined}
        >
          {getNetworkLabel(network)}
        </span>
      </header>

      {isConnecting && (
        <div className="mt-3 flex items-center gap-2 text-neutral-600 dark:text-neutral-300" role="status">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600"
          />
          Connecting to your wallet…
        </div>
      )}

      {isConnected && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <code
                className="rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
                title={address}
              >
                {shortenAddress(address)}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                aria-label="Copy wallet address"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <span className="sr-only" aria-live="polite">
                {copied ? "Address copied to clipboard" : ""}
              </span>
            </div>

            <div className="text-right">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">Balance</span>
              <p className="font-medium text-neutral-900 dark:text-neutral-100">
                {isLoadingBalance ? (
                  <span className="animate-pulse text-neutral-400">Loading…</span>
                ) : displayedBalanceError ? (
                  <span className="text-xs font-normal text-red-500">{displayedBalanceError}</span>
                ) : formattedBalance !== null ? (
                  `${formattedBalance} XLM`
                ) : (
                  "—"
                )}
              </p>
            </div>
          </div>

          {displayedBalanceError && (
            <button
              type="button"
              onClick={refreshBalance}
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Retry balance
            </button>
          )}

          {mismatched && (
            <div
              role="alert"
              className="rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-100"
            >
              <p className="font-semibold">
                Wrong network: connected to {getNetworkLabel(network)}
              </p>
              <p className="mt-1">
                StellarHunts requires {getNetworkLabel(expectedNetwork)}. On-chain actions are
                disabled until the networks match.
              </p>
              {onSwitchNetwork && (
                <button
                  type="button"
                  onClick={onSwitchNetwork}
                  className="mt-2 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-300"
                >
                  {canSwitchNetwork
                    ? `Switch to ${getNetworkLabel(expectedNetwork)}`
                    : "Retry network check"}
                </button>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={onDisconnect}
            disabled={typeof onDisconnect !== "function"}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Disconnect
          </button>
        </div>
      )}

      {!isConnected && !isConnecting && (
        <div className="mt-3 space-y-2">
          <p className="text-neutral-600 dark:text-neutral-300">
            No wallet connected.
          </p>
          {error && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
          {onConnect && (
            <button
              type="button"
              onClick={onConnect}
              className="w-full rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
            >
              Connect wallet
            </button>
          )}
        </div>
      )}
    </section>
  );
}
