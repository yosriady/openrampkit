// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";
import {MockUSDC, MockVault} from "./mocks/Mocks.sol";

/// @dev Drives random settlements (plain and vault) and random stray deposits.
contract SettlementHandler is Test {
    OpenRampSettlement public immutable settlement;
    MockUSDC public immutable usdc;
    MockVault public immutable vault;
    address public immutable recipient = makeAddr("recipient");

    uint256 public stray;
    uint256 public settledTotal;
    uint256 public settledCount;
    uint256 private _nonce;

    constructor(OpenRampSettlement s, MockUSDC u, MockVault v) {
        settlement = s;
        usdc = u;
        vault = v;
    }

    function settlePlain(uint256 amount) external {
        amount = bound(amount, 1, 1e15);
        _settle(amount, new OpenRampSettlement.Call[](0));
    }

    function settleVault(uint256 amount, uint256 part) external {
        amount = bound(amount, 1, 1e15);
        part = bound(part, 1, amount);
        OpenRampSettlement.Call[] memory calls = new OpenRampSettlement.Call[](1);
        calls[0] = OpenRampSettlement.Call(address(vault), abi.encodeCall(vault.deposit, (part, recipient)));
        _settle(amount, calls);
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 0, 1e12);
        usdc.mint(address(settlement), amount);
        stray += amount;
    }

    function _settle(uint256 amount, OpenRampSettlement.Call[] memory calls) private {
        address payer = address(uint160(0x1000 + (_nonce % 7)));
        usdc.mint(payer, amount);
        vm.startPrank(payer);
        usdc.approve(address(settlement), amount);
        OpenRampSettlement.Settlement memory s =
            OpenRampSettlement.Settlement(keccak256(abi.encode(++_nonce)), address(usdc), amount, recipient, calls);
        OpenRampSettlement.Intent memory none;
        settlement.settle(s, none);
        vm.stopPrank();
        settledTotal += amount;
        ++settledCount;
    }
}

contract OpenRampSettlementInvariantTest is Test {
    OpenRampSettlement internal settlement;
    MockUSDC internal usdc;
    MockVault internal vault;
    SettlementHandler internal handler;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(IERC20(address(usdc)));
        address[] memory targets = new address[](1);
        targets[0] = address(vault);
        settlement = new OpenRampSettlement(address(this), address(0), targets);
        handler = new SettlementHandler(settlement, usdc, vault);
        targetContract(address(handler));
    }

    /// The contract never keeps settled funds: its balance is exactly the stray donations.
    function invariant_holdsOnlyStrayFunds() public view {
        assertEq(usdc.balanceOf(address(settlement)), handler.stray());
    }

    /// Everything settled reached the recipient, as tokens or as vault assets.
    function invariant_recipientGetsEverything() public view {
        assertEq(usdc.balanceOf(handler.recipient()) + vault.totalAssets(), handler.settledTotal());
    }

    /// The contract never keeps an allowance to a call target.
    function invariant_noStandingAllowance() public view {
        assertEq(usdc.allowance(address(settlement), address(vault)), 0);
    }
}
