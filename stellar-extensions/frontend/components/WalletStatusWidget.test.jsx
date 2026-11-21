import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Networks } from "@stellar/stellar-sdk";

import WalletStatusWidget, {
  formatBalance,
  getNetworkLabel,
  shortenAddress,
} from "./WalletStatusWidget";

const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

const render = (props) => renderToStaticMarkup(<WalletStatusWidget {...props} />);

describe("WalletStatusWidget", () => {
  it("shows the disconnected state", () => {
    const html = render({ onConnect: () => {} });

    expect(html).toContain("Not connected");
    expect(html).toContain("No wallet connected.");
    expect(html).toContain("Connect wallet");
  });

  it("shows a loading state while connecting", () => {
    const html = render({ status: "connecting" });

    expect(html).toContain("Connecting to your wallet");
    expect(html).not.toContain("No wallet connected.");
  });

  it("renders the truncated address, network and balance", () => {
    const html = render({
      address: ADDRESS,
      status: "connected",
      network: Networks.TESTNET,
      expectedNetwork: Networks.TESTNET,
      balance: "1234.5000000",
    });

    expect(html).toContain("GABC...STUV");
    expect(html).toContain(ADDRESS); // full address in the title/aria label
    expect(html).toContain("Testnet");
    expect(html).toContain("1,234.5 XLM");
    expect(html).toContain("Copy wallet address");
    expect(html).toContain("Disconnect");
  });

  it("warns when the wallet is on the wrong network", () => {
    const html = render({
      address: ADDRESS,
      status: "connected",
      network: Networks.TESTNET,
      expectedNetwork: Networks.PUBLIC,
      balance: "10",
      canSwitchNetwork: true,
      onSwitchNetwork: () => {},
    });

    expect(html).toContain("Wrong network");
    expect(html).toContain("Switch to Mainnet");
  });

  it("surfaces connection errors", () => {
    const html = render({
      status: "error",
      error: "Wallet connection was rejected.",
    });

    expect(html).toContain("Wallet connection was rejected.");
  });

  it("surfaces balance errors with a retry action", () => {
    const html = render({
      address: ADDRESS,
      status: "connected",
      network: Networks.PUBLIC,
      expectedNetwork: Networks.PUBLIC,
      balance: null,
      balanceError: "Account is not funded on this network.",
    });

    expect(html).toContain("Account is not funded on this network.");
    expect(html).toContain("Retry balance");
  });
});

describe("WalletStatusWidget helpers", () => {
  it("truncates addresses", () => {
    expect(shortenAddress(ADDRESS)).toBe("GABC...STUV");
    expect(shortenAddress(null)).toBe("");
  });

  it("labels networks and falls back to the passphrase", () => {
    expect(getNetworkLabel(Networks.PUBLIC)).toBe("Mainnet");
    expect(getNetworkLabel(Networks.TESTNET)).toBe("Testnet");
    expect(getNetworkLabel("Custom Network")).toBe("Custom Network");
    expect(getNetworkLabel(null)).toBe("Unknown network");
  });

  it("formats XLM balances", () => {
    expect(formatBalance("1234.5000000")).toBe("1,234.5");
    expect(formatBalance("0.0000001")).toBe("0.0000001");
    expect(formatBalance(null)).toBeNull();
  });
});
