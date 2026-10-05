// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";

/// @notice Deploys OpenRampSettlement.
///
/// Environment:
/// - `DEPLOYER_PRIVATE_KEY` (required): the deployer key. Never commit it.
/// - `SETTLEMENT_OWNER` (optional): the owner; default is the deployer. Use a multisig in production.
/// - `SETTLEMENT_INTENT_SIGNER`: the OpenRampKit server signer. Required on every chain that is not a
///   known testnet (see `isTestnet`). On a testnet the default is zero (intents off).
/// - `SETTLEMENT_ALLOWED_TARGETS` (optional): comma-separated call targets, e.g. ERC-4626 vaults.
/// - `SETTLEMENT_SALT` (optional): a bytes32 salt. When set, the script deploys with CREATE2 through the
///   standard deterministic deployer, so the same salt and constructor arguments give the same address
///   on every chain.
///
/// Dry run against a local anvil:
///   anvil &
///   DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
///     forge script script/Deploy.s.sol --rpc-url anvil --broadcast
///
/// Arbitrum Sepolia (421614):
///   forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast --verify
contract Deploy is Script {
    /// @notice A deploy to a chain that is not a known testnet has no intent signer.
    error IntentSignerRequired(uint256 chainId);

    /// @notice Chains where a deploy may start with no intent signer. Every other chain id needs one,
    /// so a new mainnet is safe by default.
    function isTestnet(uint256 chainId) public pure returns (bool) {
        return chainId == 31_337 // anvil
            || chainId == 421_614 // Arbitrum Sepolia
            || chainId == 46_630 // Robinhood Chain Testnet
            || chainId == 42_431 // Tempo Testnet (Moderato)
            || chainId == 11_155_111; // Ethereum Sepolia
    }

    /// @notice Reverts when the deploy would start a non-testnet contract with no intent signer.
    /// With no signer, `settle` is open to any payer and anyone can grief a session id.
    function checkConfig(uint256 chainId, address signer) public pure {
        if (signer == address(0) && !isTestnet(chainId)) revert IntentSignerRequired(chainId);
    }

    function run() external returns (OpenRampSettlement settlement) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address owner = vm.envOr("SETTLEMENT_OWNER", deployer);
        address signer = vm.envOr("SETTLEMENT_INTENT_SIGNER", address(0));
        address[] memory targets = vm.envOr("SETTLEMENT_ALLOWED_TARGETS", ",", new address[](0));
        bytes32 salt = vm.envOr("SETTLEMENT_SALT", bytes32(0));

        console2.log("chain id      ", block.chainid);
        console2.log("deployer      ", deployer);
        console2.log("owner         ", owner);
        console2.log("intent signer ", signer);
        console2.log("targets       ", targets.length);
        checkConfig(block.chainid, signer);
        if (!isTestnet(block.chainid) && owner.code.length == 0) {
            console2.log("WARNING: the owner is not a contract. Transfer ownership to a Safe (see RUNBOOK.md).");
        }

        vm.startBroadcast(key);
        settlement = salt == bytes32(0)
            ? new OpenRampSettlement(owner, signer, targets)
            : new OpenRampSettlement{salt: salt}(owner, signer, targets);
        vm.stopBroadcast();

        console2.log("OpenRampSettlement", address(settlement));
    }
}
