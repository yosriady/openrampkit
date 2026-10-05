# Test coverage

Tool: forge 1.8.3 (`forge coverage`). Run it from `contracts/`:

```sh
forge coverage --no-match-coverage '(script|test)' --report summary --report lcov --report-file audit/lcov.info
```

The filter removes the deploy scripts, the tests and the mocks from the table. The raw LCOV file is [lcov.info](lcov.info).

| File | % Lines | % Statements | % Branches | % Funcs |
|---|---|---|---|---|
| src/OpenRampSettlement.sol | 100.00% (98/98) | 100.00% (125/125) | 100.00% (23/23) | 100.00% (21/21) |
| Total | 100.00% (98/98) | 100.00% (125/125) | 100.00% (23/23) | 100.00% (21/21) |

## Test suites

| Suite | File | What it checks |
|---|---|---|
| Unit tests (49) | `test/OpenRampSettlement.t.sol` | Each revert path, each admin function, intents (EOA and ERC-1271 signers), call bundles, pause, reentrancy, fee-on-transfer tokens, sweep, two-step ownership, and `settleFromBalance`: the exact signed amount, no drain of the pooled balance with a raised amount, no reuse of a `settle` intent and the reverse |
| Fuzz tests (6, 1,024 runs; 4,096 in CI) | `test/OpenRampSettlement.t.sol` | Funds are conserved, each session settles once, vault deposits, the intent verifies for the exact recipient only, `settleFromBalance` pays only the signed amount, and a raised amount always reverts |
| Invariant tests (4) | `test/OpenRampSettlement.invariant.t.sol` | Random plain, vault and pooled-balance settlements (all signed), solver fills and stray donations. Before each pooled settlement, an attacker tries a wrong amount. The contract holds only stray funds and pending fills. A wrong amount never settles. The recipient gets everything. No allowance to a call target stays after a settlement. |
| Deploy script tests (4) | `test/Deploy.t.sol` | The deploy script stops on a non-testnet chain with no intent signer |

Line and branch coverage show that each line and branch runs in a test. They do not prove that the contract is correct. See [static-analysis.md](static-analysis.md) for the static analysis.
