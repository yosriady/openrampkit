// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";

/// @notice Deploys OpenRampSettlement.
///
/// Environment:
/// - `DEPLOYER_PRIVATE_KEY` (required): the deployer key. Never commit it.
/// - `SETTLEMENT_OWNER` (optional): the owner; default is the deployer. Use a multisig in production.
/// - `SETTLEMENT_INTENT_SIGNER` (optional): the OpenRampKit server signer; default zero (intents off).
/// - `SETTLEMENT_ALLOWED_TARGETS` (optional): comma-separated call targets, e.g. ERC-4626 vaults.
///
/// Dry run against a local anvil:
///   anvil &
///   DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
///     forge script script/Deploy.s.sol --rpc-url anvil --broadcast
///
/// Arbitrum Sepolia (421614):
///   forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast --verify
contract Deploy is Script {
    function run() external returns (OpenRampSettlement settlement) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address owner = vm.envOr("SETTLEMENT_OWNER", deployer);
        address signer = vm.envOr("SETTLEMENT_INTENT_SIGNER", address(0));
        address[] memory targets = vm.envOr("SETTLEMENT_ALLOWED_TARGETS", ",", new address[](0));

        console2.log("chain id      ", block.chainid);
        console2.log("deployer      ", deployer);
        console2.log("owner         ", owner);
        console2.log("intent signer ", signer);
        console2.log("targets       ", targets.length);

        vm.startBroadcast(key);
        settlement = new OpenRampSettlement(owner, signer, targets);
        vm.stopBroadcast();

        console2.log("OpenRampSettlement", address(settlement));
    }
}
