# Soroban Deployment Scripts

`deploy-soroban-contract.sh` builds a workspace contract, uploads its WASM,
deploys it, calls `get_schema_version` for verification, and writes deployment
metadata to `deployments.json`.

```bash
# Testnet
./stellar-extensions/scripts/deploy-soroban-contract.sh \
  --network testnet \
  --source "$SOROBAN_DEPLOYER_SECRET"

# Mainnet
./stellar-extensions/scripts/deploy-soroban-contract.sh \
  --network mainnet \
  --source "$SOROBAN_DEPLOYER_SECRET"
```

`STELLAR_SOURCE` may replace `--source`. The script requires the `stellar`
CLI and Rust's `wasm32-unknown-unknown` target. Deployment JSON includes:
contract ID, WASM code hash, transaction hash, verification method/result,
network, and UTC timestamp.
