# Stellar Extensions — Tests

Integration tests for features contributed under `stellar-extensions/`.

## Referral system

`referral/referral.integration.test.ts` wires the real backend referral
services (`backend/src/referral/`) together with in-memory repositories and
covers the full flow:

- referral code / link generation
- attribution on registration
- reward distribution when the referee completes their first puzzle
- multi-level (`A -> B -> C`) referral rewards
- self-referral and duplicate attribution prevention
- referral statistics and pending/processed bonus totals

Run it from the repository root (Jest and ts-jest are already installed at the
root workspace):

```bash
npx jest --config stellar-extensions/tests/jest.config.js
```
