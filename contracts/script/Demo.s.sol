// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";
import {MockUSDC, MockVault} from "../test/mocks/Mocks.sol";

/// @notice Testnet demo: settles two sessions on a deployed OpenRampSettlement with a TEST token.
///
/// It deploys a mock USDC (open mint, no value) and a mock ERC-4626 vault, allows the vault as a
/// call target, then settles:
/// 1. `ors_demo_plain`: 25 test USDC straight to the recipient.
/// 2. `ors_demo_vault`: 25 test USDC deposited into the vault for the recipient, in the same transaction.
///
/// Testnets only. The deployer must be the settlement owner.
///
/// Environment: `DEPLOYER_PRIVATE_KEY`, `SETTLEMENT` (the deployed contract),
/// `DEMO_RECIPIENT` (optional, default the deployer). `DEMO_TOKEN` and `DEMO_VAULT` (optional): an
/// existing open-mint test token and its ERC-4626 vault to use again, instead of new ones. The vault
/// must already be an allowed call target, or the deployer (the owner) allows it here.
///
///   forge script script/Demo.s.sol --rpc-url arbitrum_sepolia --broadcast
contract Demo is Script {
    function run() external {
        require(block.chainid != 1 && block.chainid != 42_161 && block.chainid != 4663, "testnets only");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        OpenRampSettlement settlement = OpenRampSettlement(vm.envAddress("SETTLEMENT"));
        address recipient = vm.envOr("DEMO_RECIPIENT", deployer);
        uint256 amount = 25e6;

        vm.startBroadcast(key);
        address tokenAddr = vm.envOr("DEMO_TOKEN", address(0));
        MockUSDC usdc = tokenAddr == address(0) ? new MockUSDC() : MockUSDC(tokenAddr);
        address vaultAddr = vm.envOr("DEMO_VAULT", address(0));
        MockVault vault = vaultAddr == address(0) ? new MockVault(IERC20(address(usdc))) : MockVault(vaultAddr);
        if (!settlement.isAllowedTarget(address(vault))) settlement.setAllowedTarget(address(vault), true);
        usdc.mint(deployer, 2 * amount);
        usdc.approve(address(settlement), 2 * amount);

        OpenRampSettlement.Intent memory none;

        OpenRampSettlement.Settlement memory plain;
        plain.sessionId = bytes32("ors_demo_plain");
        plain.token = address(usdc);
        plain.amount = amount;
        plain.recipient = recipient;
        plain.calls = new OpenRampSettlement.Call[](0);
        settlement.settle(plain, none);

        OpenRampSettlement.Settlement memory toVault;
        toVault.sessionId = bytes32("ors_demo_vault");
        toVault.token = address(usdc);
        toVault.amount = amount;
        toVault.recipient = recipient;
        toVault.calls = new OpenRampSettlement.Call[](1);
        toVault.calls[0] =
            OpenRampSettlement.Call({target: address(vault), data: abi.encodeCall(vault.deposit, (amount, recipient))});
        settlement.settle(toVault, none);
        vm.stopBroadcast();

        console2.log("test USDC     ", address(usdc));
        console2.log("test vault    ", address(vault));
        console2.log("vault shares  ", vault.balanceOf(recipient));
    }
}
