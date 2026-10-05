// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";
import {MockUSDC, MockVault} from "./mocks/Mocks.sol";

/// @dev Drives random settlements (plain, vault, and from a pooled balance), solver fills, and random
/// stray deposits. Every settlement carries a signed intent. For `settleFromBalance`, the handler first
/// tries a wrong amount (as an attacker would) and records it if that ever succeeds.
contract SettlementHandler is Test {
    OpenRampSettlement public immutable settlement;
    MockUSDC public immutable usdc;
    MockVault public immutable vault;
    uint256 public immutable signerKey;
    address public immutable recipient = makeAddr("recipient");

    uint256 public stray;
    uint256 public settledTotal;
    uint256 public settledCount;
    /// Solver fills that arrived in the contract but did not settle yet.
    uint256 public pendingTotal;
    /// Times that a `settleFromBalance` with a wrong amount did not revert. Must stay zero.
    uint256 public wrongAmountSettled;
    uint256 public balanceSettledCount;
    uint256 private _nonce;

    struct Fill {
        bytes32 sessionId;
        uint256 amount;
    }

    Fill[] private _pending;

    constructor(OpenRampSettlement s, MockUSDC u, MockVault v, uint256 key) {
        settlement = s;
        usdc = u;
        vault = v;
        signerKey = key;
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

    /// A bridge or solver sends funds for a new session, but does not settle yet.
    function fill(uint256 amount) external {
        amount = bound(amount, 1, 1e15);
        usdc.mint(address(settlement), amount);
        _pending.push(Fill(keccak256(abi.encode("fill", ++_nonce)), amount));
        pendingTotal += amount;
    }

    /// Someone settles one pending fill from the pool. First an attacker tries `tried` (which may be
    /// up to the whole balance), then the exact signed amount settles.
    function settleFromBalance(uint256 index, uint256 tried, bool raiseMin, bool vaultCall) external {
        if (_pending.length == 0) return;
        index = bound(index, 0, _pending.length - 1);
        Fill memory f = _pending[index];
        _pending[index] = _pending[_pending.length - 1];
        _pending.pop();

        OpenRampSettlement.Settlement memory s = OpenRampSettlement.Settlement(
            f.sessionId, address(usdc), f.amount, recipient, new OpenRampSettlement.Call[](0)
        );
        if (vaultCall) {
            s.calls = new OpenRampSettlement.Call[](1);
            s.calls[0] = OpenRampSettlement.Call(address(vault), abi.encodeCall(vault.deposit, (f.amount, recipient)));
        }
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(signerKey, settlement.balanceIntentDigest(s, address(0), deadline));
        OpenRampSettlement.Intent memory intent =
            OpenRampSettlement.Intent(address(0), f.amount, deadline, abi.encodePacked(r, sig, v));

        tried = bound(tried, 1, usdc.balanceOf(address(settlement)));
        if (tried != f.amount) {
            // Copies, not aliases: the honest call below must still use the signed values.
            OpenRampSettlement.Settlement memory bad =
                OpenRampSettlement.Settlement(s.sessionId, s.token, tried, s.recipient, s.calls);
            OpenRampSettlement.Intent memory badIntent = OpenRampSettlement.Intent(
                intent.payer, raiseMin ? tried : intent.minAmount, intent.deadline, intent.signature
            );
            try settlement.settleFromBalance(bad, badIntent) {
                ++wrongAmountSettled;
            } catch {}
        }

        settlement.settleFromBalance(s, intent);
        pendingTotal -= f.amount;
        settledTotal += f.amount;
        ++settledCount;
        ++balanceSettledCount;
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
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(signerKey, settlement.intentDigest(s, payer, amount, deadline));
        settlement.settle(s, OpenRampSettlement.Intent(payer, amount, deadline, abi.encodePacked(r, sig, v)));
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
        uint256 signerKey = 0x5161E5;
        settlement = new OpenRampSettlement(address(this), vm.addr(signerKey), targets);
        handler = new SettlementHandler(settlement, usdc, vault, signerKey);
        targetContract(address(handler));
    }

    /// The contract never keeps settled funds: its balance is exactly the stray donations plus the
    /// solver fills that did not settle yet. A settlement from the pool never takes another session's funds.
    function invariant_holdsOnlyStrayAndPendingFunds() public view {
        assertEq(usdc.balanceOf(address(settlement)), handler.stray() + handler.pendingTotal());
    }

    /// `settleFromBalance` with any amount other than the signed one never succeeds.
    function invariant_balancePathPaysOnlySignedAmount() public view {
        assertEq(handler.wrongAmountSettled(), 0);
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
