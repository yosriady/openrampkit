# Test coverage

Tool: forge 1.8.3 (`forge coverage`). Run it from `contracts/`:

```sh
forge coverage --no-match-coverage '(script|test)' --report summary --report lcov --report-file audit/lcov.info
```

The filter removes the deploy scripts, the tests and the mocks from the table. The raw LCOV file is [lcov.info](lcov.info).

| File | % Lines | % Statements | % Branches | % Funcs |
|---|---|---|---|---|
| src/OpenRampSettlement.sol | 100.00% (91/91) | 100.00% (118/118) | 100.00% (20/20) | 100.00% (19/19) |
| Total | 100.00% (91/91) | 100.00% (118/118) | 100.00% (20/20) | 100.00% (19/19) |

## Test suites

| Suite | File | What it checks |
|---|---|---|
| Unit tests (42) | `test/OpenRampSettlement.t.sol` | Each revert path, each admin function, intents (EOA and ERC-1271 signers), call bundles, pause, reentrancy, fee-on-transfer tokens, sweep, two-step ownership |
| Fuzz tests (4, 1,024 runs; 4,096 in CI) | `test/OpenRampSettlement.t.sol` | Funds are conserved, each session settles once, vault deposits, the intent verifies for the exact recipient only |
| Invariant tests (3) | `test/OpenRampSettlement.invariant.t.sol` | Random plain settlements, vault settlements and stray donations. The contract holds only stray funds. The recipient gets everything. No allowance to a call target stays after a settlement. |

Line and branch coverage show that each line and branch runs in a test. They do not prove that the contract is correct. See [static-analysis.md](static-analysis.md) for the static analysis.
