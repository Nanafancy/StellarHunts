# Stellar Extensions — Frontend

## WalletStatusWidget

`components/WalletStatusWidget.jsx` is a compact wallet status card (#904):

- truncated wallet address with a copy button
- network indicator (Mainnet / Testnet / custom passphrase)
- XLM balance loaded from Horizon (`hooks/useStellarBalance.js`)
- network mismatch warning banner
- connected, connecting, disconnected and error states
- disconnect button

It is presentational, so it can be paired with the app's existing wallet
session hook:

```jsx
import WalletStatusWidget from "@/stellar-extensions/frontend/components/WalletStatusWidget";
import { useWalletConnection } from "@/hooks/useWalletConnection";

function WalletPanel() {
  const wallet = useWalletConnection();

  return (
    <WalletStatusWidget
      address={wallet.address}
      status={wallet.status}
      network={wallet.network}
      expectedNetwork={wallet.expectedNetwork}
      error={wallet.error}
      onConnect={wallet.connect}
      onDisconnect={wallet.disconnect}
      onSwitchNetwork={wallet.switchNetwork}
      canSwitchNetwork={wallet.switchSupported}
    />
  );
}
```

Pass `balance`, `balanceLoading` and `balanceError` to control the balance
display; when `balance` is omitted the widget fetches it from Horizon itself.
Set `NEXT_PUBLIC_HORIZON_URL` to use a custom or proxied Horizon endpoint.
