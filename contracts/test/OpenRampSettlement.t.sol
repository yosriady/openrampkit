// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ERC1271WalletMock} from "@openzeppelin/contracts/mocks/ERC1271WalletMock.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";
import {
    MockUSDC,
    MockVault,
    FeeOnTransferToken,
    PartialSpender,
    RevertingTarget,
    GreedyTarget,
    ReentrantTarget
} from "./mocks/Mocks.sol";

contract OpenRampSettlementTest is Test {
    OpenRampSettlement internal settlement;
    MockUSDC internal usdc;
    MockVault internal vault;

    address internal owner = makeAddr("owner");
    address internal payer = makeAddr("payer");
    address internal recipient = makeAddr("recipient");
    address internal solver = makeAddr("solver");
    uint256 internal signerKey = 0xA11CE;
    address internal signer = vm.addr(signerKey);

    bytes32 internal constant SID = bytes32("ors_0123456789abcdef01234567");
    uint256 internal constant AMOUNT = 250e6;

    event Settled(
        bytes32 indexed sessionId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 callsHash
    );

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(IERC20(address(usdc)));
        address[] memory targets = new address[](1);
        targets[0] = address(vault);
        settlement = new OpenRampSettlement(owner, address(0), targets);

        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(settlement), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _settlement(bytes32 sid, uint256 amount) internal view returns (OpenRampSettlement.Settlement memory s) {
        s.sessionId = sid;
        s.token = address(usdc);
        s.amount = amount;
        s.recipient = recipient;
    }

    function _vaultCalls(uint256 amount) internal view returns (OpenRampSettlement.Call[] memory calls) {
        calls = new OpenRampSettlement.Call[](1);
        calls[0] = OpenRampSettlement.Call(address(vault), abi.encodeCall(vault.deposit, (amount, recipient)));
    }

    function _noIntent() internal pure returns (OpenRampSettlement.Intent memory i) {}

    function _enableSigner() internal {
        vm.prank(owner);
        settlement.setIntentSigner(signer);
    }

    function _sign(OpenRampSettlement.Settlement memory s, address intentPayer, uint256 minAmount, uint256 deadline)
        internal
        view
        returns (OpenRampSettlement.Intent memory i)
    {
        bytes32 digest = settlement.intentDigest(s, intentPayer, minAmount, deadline);
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(signerKey, digest);
        i = OpenRampSettlement.Intent(intentPayer, minAmount, deadline, abi.encodePacked(r, sig, v));
    }

    // ------------------------------------------------------------------ constructor and admin

    function test_constructor_setsState() public view {
        assertEq(settlement.owner(), owner);
        assertEq(settlement.intentSigner(), address(0));
        assertTrue(settlement.isAllowedTarget(address(vault)));
    }

    function test_constructor_rejectsEoaTarget() public {
        address[] memory targets = new address[](1);
        targets[0] = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.NotAContract.selector, targets[0]));
        new OpenRampSettlement(owner, address(0), targets);
    }

    function test_admin_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(err);
        settlement.setIntentSigner(signer);
        vm.expectRevert(err);
        settlement.setAllowedTarget(address(vault), false);
        vm.expectRevert(err);
        settlement.pause();
        vm.expectRevert(err);
        settlement.unpause();
        vm.expectRevert(err);
        settlement.sweep(address(usdc), owner, 1);
        vm.expectRevert(err);
        settlement.renounceOwnership();
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(owner);
        vm.expectRevert(OpenRampSettlement.RenounceDisabled.selector);
        settlement.renounceOwnership();
    }

    function test_ownership_twoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        settlement.transferOwnership(next);
        assertEq(settlement.owner(), owner);
        vm.prank(next);
        settlement.acceptOwnership();
        assertEq(settlement.owner(), next);
    }

    function test_setAllowedTarget_emitsAndUpdates() public {
        vm.expectEmit(address(settlement));
        emit OpenRampSettlement.AllowedTargetUpdated(address(vault), false);
        vm.prank(owner);
        settlement.setAllowedTarget(address(vault), false);
        assertFalse(settlement.isAllowedTarget(address(vault)));
    }

    function test_setIntentSigner_emits() public {
        vm.expectEmit(address(settlement));
        emit OpenRampSettlement.IntentSignerUpdated(address(0), signer);
        _enableSigner();
        assertEq(settlement.intentSigner(), signer);
    }

    function test_sweep_movesStrayFunds() public {
        usdc.mint(address(settlement), 5e6);
        vm.expectEmit(address(settlement));
        emit OpenRampSettlement.Swept(address(usdc), owner, 5e6);
        vm.prank(owner);
        settlement.sweep(address(usdc), owner, 5e6);
        assertEq(usdc.balanceOf(owner), 5e6);
    }

    function test_sweep_rejectsZeroTo() public {
        vm.prank(owner);
        vm.expectRevert(OpenRampSettlement.ZeroAddress.selector);
        settlement.sweep(address(usdc), address(0), 1);
    }

    // ------------------------------------------------------------------ settle: plain transfer

    function test_settle_forwardsToRecipient() public {
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        vm.expectEmit(address(settlement));
        emit Settled(SID, payer, recipient, address(usdc), AMOUNT, settlement.hashCalls(s.calls));
        vm.prank(payer);
        settlement.settle(s, _noIntent());

        assertEq(usdc.balanceOf(recipient), AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertTrue(settlement.isSettled(SID));
        OpenRampSettlement.Receipt memory r = settlement.receiptOf(SID);
        assertEq(r.payer, payer);
        assertEq(r.token, address(usdc));
        assertEq(r.recipient, recipient);
        assertEq(r.amount, AMOUNT);
        assertEq(r.settledAt, block.timestamp);
    }

    function test_settle_replayReverts() public {
        vm.startPrank(payer);
        settlement.settle(_settlement(SID, AMOUNT), _noIntent());
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.AlreadySettled.selector, SID));
        settlement.settle(_settlement(SID, 1), _noIntent());
        vm.stopPrank();
    }

    function test_settle_rejectsBadInput() public {
        vm.startPrank(payer);
        vm.expectRevert(OpenRampSettlement.ZeroSessionId.selector);
        settlement.settle(_settlement(bytes32(0), AMOUNT), _noIntent());

        OpenRampSettlement.Settlement memory s = _settlement(SID, 0);
        vm.expectRevert(OpenRampSettlement.ZeroAmount.selector);
        settlement.settle(s, _noIntent());

        s = _settlement(SID, AMOUNT);
        s.recipient = address(0);
        vm.expectRevert(OpenRampSettlement.ZeroAddress.selector);
        settlement.settle(s, _noIntent());

        s = _settlement(SID, AMOUNT);
        s.token = makeAddr("notatoken");
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.NotAContract.selector, s.token));
        settlement.settle(s, _noIntent());
        vm.stopPrank();
    }

    function test_settle_withoutAllowanceReverts() public {
        address poor = makeAddr("poor");
        usdc.mint(poor, AMOUNT);
        vm.prank(poor);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(settlement), 0, AMOUNT)
        );
        settlement.settle(_settlement(SID, AMOUNT), _noIntent());
        assertFalse(settlement.isSettled(SID));
    }

    function test_settle_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(payer, AMOUNT);
        vm.startPrank(payer);
        fee.approve(address(settlement), AMOUNT);
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.token = address(fee);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.UnsupportedToken.selector, address(fee)));
        settlement.settle(s, _noIntent());
        vm.stopPrank();
    }

    function test_settle_whenPausedReverts() public {
        vm.prank(owner);
        settlement.pause();
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.settle(_settlement(SID, AMOUNT), _noIntent());

        vm.prank(owner);
        settlement.unpause();
        vm.prank(payer);
        settlement.settle(_settlement(SID, AMOUNT), _noIntent());
        assertTrue(settlement.isSettled(SID));
    }

    function test_settle_doesNotTouchStrayFunds() public {
        usdc.mint(address(settlement), 7e6);
        vm.prank(payer);
        settlement.settle(_settlement(SID, AMOUNT), _noIntent());
        assertEq(usdc.balanceOf(address(settlement)), 7e6);
        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    // ------------------------------------------------------------------ settle: call bundles

    function test_settle_depositsIntoVaultForRecipient() public {
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = _vaultCalls(AMOUNT);
        vm.expectEmit(address(settlement));
        emit Settled(SID, payer, recipient, address(usdc), AMOUNT, settlement.hashCalls(s.calls));
        vm.prank(payer);
        settlement.settle(s, _noIntent());

        assertEq(vault.balanceOf(recipient), AMOUNT); // 1:1 on an empty vault
        assertEq(vault.totalAssets(), AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(usdc.allowance(address(settlement), address(vault)), 0);
        assertEq(vault.balanceOf(address(settlement)), 0);
    }

    function test_settle_leftoverGoesToRecipient() public {
        PartialSpender spender = new PartialSpender();
        vm.prank(owner);
        settlement.setAllowedTarget(address(spender), true);
        address merchant = makeAddr("merchant");

        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(
            address(spender), abi.encodeCall(PartialSpender.pull, (IERC20(address(usdc)), 100e6, merchant))
        );
        vm.prank(payer);
        settlement.settle(s, _noIntent());

        assertEq(usdc.balanceOf(merchant), 100e6);
        assertEq(usdc.balanceOf(recipient), AMOUNT - 100e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(usdc.allowance(address(settlement), address(spender)), 0);
    }

    function test_settle_rejectsTargetNotAllowed() public {
        PartialSpender spender = new PartialSpender();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(address(spender), "");
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.TargetNotAllowed.selector, address(spender)));
        settlement.settle(s, _noIntent());
        assertFalse(settlement.isSettled(SID));
    }

    function test_settle_rejectsTokenAsTarget() public {
        // Even if the owner allowlists the token by mistake, a bundle cannot call it
        // (it would allow `transfer` of stray funds).
        vm.prank(owner);
        settlement.setAllowedTarget(address(usdc), true);
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(address(usdc), abi.encodeCall(IERC20.transfer, (payer, 1)));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.TargetNotAllowed.selector, address(usdc)));
        settlement.settle(s, _noIntent());
    }

    function test_settle_rejectsSelfAsTarget() public {
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(address(settlement), "");
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.TargetNotAllowed.selector, address(settlement)));
        settlement.settle(s, _noIntent());
    }

    function test_settle_bubblesCallFailure() public {
        RevertingTarget bad = new RevertingTarget();
        vm.prank(owner);
        settlement.setAllowedTarget(address(bad), true);
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(address(bad), abi.encodeCall(RevertingTarget.boom, ()));
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OpenRampSettlement.CallFailed.selector, 0, abi.encodeWithSignature("Error(string)", "boom")
            )
        );
        settlement.settle(s, _noIntent());
        // Atomic: nothing moved, the session can still settle.
        assertFalse(settlement.isSettled(SID));
        assertEq(usdc.balanceOf(payer), 1_000_000e6);
    }

    function test_settle_callBundleCannotSpendStrayFunds() public {
        // Stray funds sit in the contract. A bundle that calls the same greedy target twice gets a
        // fresh allowance each time, but the balance invariant stops it from taking the stray funds.
        usdc.mint(address(settlement), AMOUNT);
        GreedyTarget greedy = new GreedyTarget();
        vm.prank(owner);
        settlement.setAllowedTarget(address(greedy), true);
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](2);
        bytes memory data = abi.encodeCall(GreedyTarget.steal, (IERC20(address(usdc)), AMOUNT));
        s.calls[0] = OpenRampSettlement.Call(address(greedy), data);
        s.calls[1] = OpenRampSettlement.Call(address(greedy), data);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.BalanceInvariant.selector, 0, AMOUNT));
        settlement.settle(s, _noIntent());
    }

    function test_settle_callBundleCannotExceedAllowance() public {
        usdc.mint(address(settlement), AMOUNT);
        GreedyTarget greedy = new GreedyTarget();
        vm.prank(owner);
        settlement.setAllowedTarget(address(greedy), true);
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(
            address(greedy), abi.encodeCall(GreedyTarget.steal, (IERC20(address(usdc)), 2 * AMOUNT))
        );
        vm.prank(payer);
        vm.expectRevert(); // CallFailed wrapping ERC20InsufficientAllowance
        settlement.settle(s, _noIntent());
        assertEq(usdc.balanceOf(address(settlement)), AMOUNT);
    }

    function test_settle_reentrancyBlocked() public {
        ReentrantTarget attacker = new ReentrantTarget(settlement);
        vm.prank(owner);
        settlement.setAllowedTarget(address(attacker), true);
        OpenRampSettlement.Settlement memory inner = _settlement(bytes32("inner"), 1);
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = new OpenRampSettlement.Call[](1);
        s.calls[0] = OpenRampSettlement.Call(address(attacker), abi.encodeCall(ReentrantTarget.reenter, (inner)));
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OpenRampSettlement.CallFailed.selector,
                0,
                abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
            )
        );
        settlement.settle(s, _noIntent());
    }

    // ------------------------------------------------------------------ intents

    function test_intent_requiredWhenSignerSet() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _noIntent();
        i.deadline = block.timestamp;
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(s, i);
    }

    function test_intent_validSettles() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = _vaultCalls(AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, payer, AMOUNT, block.timestamp + 600);
        vm.prank(payer);
        settlement.settle(s, i);
        assertEq(vault.balanceOf(recipient), AMOUNT);
    }

    function test_intent_bindsRecipient() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 600);
        s.recipient = makeAddr("thief");
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(s, i);
    }

    function test_intent_bindsCalls() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = _vaultCalls(AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 600);
        s.calls[0].data = abi.encodeCall(vault.deposit, (AMOUNT, payer));
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(s, i);
    }

    function test_intent_bindsTokenAndSession() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 600);
        OpenRampSettlement.Settlement memory other = _settlement(bytes32("other"), AMOUNT);
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(other, i);

        MockUSDC fake = new MockUSDC();
        fake.mint(payer, AMOUNT);
        vm.prank(payer);
        fake.approve(address(settlement), AMOUNT);
        s.token = address(fake);
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(s, i);
    }

    function test_intent_expired() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, payer, AMOUNT, block.timestamp + 60);
        vm.warp(block.timestamp + 61);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.IntentExpired.selector, i.deadline));
        settlement.settle(s, i);
    }

    function test_intent_payerMismatch() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, payer, AMOUNT, block.timestamp + 60);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.PayerMismatch.selector, payer, solver));
        settlement.settle(s, i);
    }

    function test_intent_amountBelowMinimum() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT - 1);
        OpenRampSettlement.Intent memory i = _sign(s, payer, AMOUNT, block.timestamp + 60);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.AmountBelowMinimum.selector, AMOUNT - 1, AMOUNT));
        settlement.settle(s, i);
    }

    function test_intent_amountAboveMinimumAllowed() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT + 5);
        OpenRampSettlement.Intent memory i = _sign(s, payer, AMOUNT, block.timestamp + 60);
        vm.prank(payer);
        settlement.settle(s, i);
        assertEq(usdc.balanceOf(recipient), AMOUNT + 5);
    }

    function test_intent_signatureFromOtherKeyRejected() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        bytes32 digest = settlement.intentDigest(s, payer, AMOUNT, block.timestamp + 60);
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(0xBEEF, digest);
        OpenRampSettlement.Intent memory i =
            OpenRampSettlement.Intent(payer, AMOUNT, block.timestamp + 60, abi.encodePacked(r, sig, v));
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(s, i);
    }

    function test_intent_erc1271Signer() public {
        ERC1271WalletMock wallet = new ERC1271WalletMock(signer);
        vm.prank(owner);
        settlement.setIntentSigner(address(wallet));
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, payer, AMOUNT, block.timestamp + 60);
        vm.prank(payer);
        settlement.settle(s, i);
        assertTrue(settlement.isSettled(SID));
    }

    function test_intentDigest_matchesManualEip712() public view {
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = _vaultCalls(AMOUNT);
        bytes32 callsHash = keccak256(
            abi.encodePacked(
                keccak256(abi.encode(settlement.CALL_TYPEHASH(), s.calls[0].target, keccak256(s.calls[0].data)))
            )
        );
        assertEq(callsHash, settlement.hashCalls(s.calls));
        bytes32 structHash = keccak256(
            abi.encode(settlement.INTENT_TYPEHASH(), SID, payer, address(usdc), recipient, AMOUNT, callsHash, 99)
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OpenRampSettlement"),
                keccak256("1"),
                block.chainid,
                address(settlement)
            )
        );
        assertEq(domain, settlement.domainSeparator());
        assertEq(
            settlement.intentDigest(s, payer, AMOUNT, 99), keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }

    // ------------------------------------------------------------------ settleFromBalance

    function test_settleFromBalance_requiresSigner() public {
        usdc.mint(address(settlement), AMOUNT);
        vm.prank(solver);
        vm.expectRevert(OpenRampSettlement.IntentRequired.selector);
        settlement.settleFromBalance(_settlement(SID, AMOUNT), _noIntent());
    }

    function test_settleFromBalance_solverFlowIntoVault() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        s.calls = _vaultCalls(AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 600);

        // A solver fills the contract, then anyone may complete the settlement exactly as signed.
        usdc.mint(address(settlement), AMOUNT);
        vm.expectEmit(address(settlement));
        emit Settled(SID, solver, recipient, address(usdc), AMOUNT, settlement.hashCalls(s.calls));
        vm.prank(solver);
        settlement.settleFromBalance(s, i);

        assertEq(vault.balanceOf(recipient), AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function test_settleFromBalance_insufficientBalance() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 600);
        usdc.mint(address(settlement), AMOUNT - 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.InsufficientBalance.selector, AMOUNT - 1, AMOUNT));
        settlement.settleFromBalance(s, i);
    }

    function test_settleFromBalance_replayReverts() public {
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 600);
        usdc.mint(address(settlement), 2 * AMOUNT);
        vm.startPrank(solver);
        settlement.settleFromBalance(s, i);
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.AlreadySettled.selector, SID));
        settlement.settleFromBalance(s, i);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(settlement)), AMOUNT);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_settle_conservesFunds(bytes32 sid, uint256 amount, uint256 stray) public {
        vm.assume(sid != bytes32(0));
        amount = bound(amount, 1, 1_000_000e6);
        stray = bound(stray, 0, 1e12);
        usdc.mint(address(settlement), stray);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        settlement.settle(_settlement(sid, amount), _noIntent());

        assertEq(usdc.balanceOf(payer), payerBefore - amount);
        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(settlement)), stray);
        assertEq(settlement.receiptOf(sid).amount, amount);
    }

    function testFuzz_settle_vaultDeposit(uint256 amount, uint256 depositPart) public {
        amount = bound(amount, 1, 1_000_000e6);
        depositPart = bound(depositPart, 1, amount);
        OpenRampSettlement.Settlement memory s = _settlement(SID, amount);
        s.calls = _vaultCalls(depositPart);
        vm.prank(payer);
        settlement.settle(s, _noIntent());
        assertEq(vault.balanceOf(recipient), depositPart);
        assertEq(usdc.balanceOf(recipient), amount - depositPart);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function testFuzz_intent_onlyExactRecipientVerifies(address other) public {
        vm.assume(other != recipient && other != address(0));
        _enableSigner();
        OpenRampSettlement.Settlement memory s = _settlement(SID, AMOUNT);
        OpenRampSettlement.Intent memory i = _sign(s, address(0), AMOUNT, block.timestamp + 60);
        s.recipient = other;
        vm.prank(payer);
        vm.expectRevert(OpenRampSettlement.InvalidSignature.selector);
        settlement.settle(s, i);
    }

    function testFuzz_settle_eachSessionOnce(bytes32 sid, uint256 a, uint256 b) public {
        vm.assume(sid != bytes32(0));
        a = bound(a, 1, 1e12);
        b = bound(b, 1, 1e12);
        vm.startPrank(payer);
        settlement.settle(_settlement(sid, a), _noIntent());
        vm.expectRevert(abi.encodeWithSelector(OpenRampSettlement.AlreadySettled.selector, sid));
        settlement.settle(_settlement(sid, b), _noIntent());
        vm.stopPrank();
    }
}
