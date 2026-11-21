#!/usr/bin/env bash
set -euo pipefail

NETWORK="testnet"
SOURCE=""
CONTRACT="stellar_hunts_nft"
CONFIG_FILE=""

usage() {
  cat <<'EOF'
Usage: deploy-soroban-contract.sh [options]

Options:
  --network testnet|mainnet       Stellar network (default: testnet)
  --source SECRET_KEY             Stellar source secret key
  --contract NAME                 Contract WASM name (default: stellar_hunts_nft)
  --config PATH                   Deployment config (default: scripts/deployments.json)
  --help                          Show this help

Environment:
  STELLAR_SOURCE                  Alternative to --source
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --contract) CONTRACT="$2"; shift 2 ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "Unsupported network: $NETWORK" >&2
  exit 2
fi

SOURCE="${SOURCE:-${STELLAR_SOURCE:-}}"
if [[ -z "$SOURCE" ]]; then
  echo "Missing source secret; use --source or STELLAR_SOURCE." >&2
  exit 2
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI is not installed or not on PATH." >&2
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/deployments.json}"

echo "=== StellarHunts Soroban Contract Deployer ==="
echo "Target network: $NETWORK"
echo "Contract: $CONTRACT"

cargo build --manifest-path "$WORKSPACE_ROOT/onchain/Cargo.toml" \
  --workspace --target wasm32-unknown-unknown --release

WASM_PATH="$WORKSPACE_ROOT/onchain/target/wasm32-unknown-unknown/release/${CONTRACT}.wasm"
if [[ ! -f "$WASM_PATH" ]]; then
  echo "WASM not found: $WASM_PATH" >&2
  exit 1
fi

upload_output="$(stellar contract upload "$WASM_PATH" \
  --network "$NETWORK" --source "$SOURCE" --json)"
wasm_hash="$(printf '%s' "$upload_output" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("hash") or d.get("contractWasmHash") or d.get("returnValue") or d)' )"

deploy_output="$(stellar contract deploy --wasm-hash "$wasm_hash" \
  --network "$NETWORK" --source "$SOURCE" --json)"
contract_id="$(printf '%s' "$deploy_output" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("contractId") or d.get("id") or d.get("contractAddress") or d.get("returnValue") or d)' )"
transaction_hash="$(printf '%s' "$deploy_output" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("txHash") or d.get("transactionHash") or d.get("hash") or "")' )"

verification_output="$(stellar contract invoke \
  --id "$contract_id" --network "$NETWORK" --source "$SOURCE" -- \
  get_schema_version)"

python3 - "$CONFIG_FILE" "$NETWORK" "$CONTRACT" "$contract_id" "$wasm_hash" "$transaction_hash" "$verification_output" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, network, contract, contract_id, wasm_hash, tx_hash, verification = sys.argv[1:]
try:
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

config.setdefault("contracts", {})
config.setdefault("networks", {})
config["networks"][network] = {
    "rpc": "https://soroban-testnet.stellar.org" if network == "testnet"
           else "https://soroban-mainnet.stellar.org"
}
config["contracts"][contract] = {
    "network": network,
    "contractId": contract_id,
    "wasmHash": wasm_hash,
    "transactionHash": tx_hash,
    "verification": {
        "method": "get_schema_version",
        "result": verification.strip()
    },
    "deployedAt": datetime.now(timezone.utc).isoformat()
}

from pathlib import Path
target = Path(path)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY

echo "Deployment summary"
echo "  Network: $NETWORK"
echo "  Contract: $CONTRACT"
echo "  Contract ID: $contract_id"
echo "  WASM hash: $wasm_hash"
echo "  Transaction hash: ${transaction_hash:-not returned}"
echo "  Verification (get_schema_version): $verification_output"
