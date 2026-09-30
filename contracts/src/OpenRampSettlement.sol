// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title OpenRampSettlement
/// @author OpenRampKit
/// @notice On-chain settlement point for OpenRampKit deposit sessions.
///
/// A payer (the user's wallet, or a bridge or solver that fills on this chain) settles one
/// OpenRampKit session: the contract takes `amount` of `token`, then either forwards it to
/// `recipient` or runs an allowlisted call bundle with it (for example, a deposit into an
/// ERC-4626 vault on behalf of `recipient`), all in one transaction.
///
/// Each session id settles at most once. The server verifies a deposit by reading one
/// `Settled` event (or `receiptOf`) for the session id, instead of trusting a transaction hash.
///
/// When `intentSigner` is set, every settlement must carry an EIP-712 intent signed by the
/// OpenRampKit server. The intent binds the session id, token, recipient, minimum amount, call
/// bundle and deadline (and optionally the payer), so a payer cannot redirect the funds.
///
/// @dev Design rules:
/// - No upgradeability. No native ETH. Fee-on-transfer and rebasing tokens are rejected.
/// - The contract holds no funds between transactions in the normal flow. Every settlement checks
///   that the contract balance of `token` does not drop below its balance before the settlement,
///   so a call bundle can never spend funds that belong to someone else.
/// - A call target must be on the owner's allowlist, and it can never be the token itself or this
///   contract. The contract approves `amount` to the target for the call and resets it to zero after.
contract OpenRampSettlement is Ownable2Step, Pausable, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    /// @notice One call of a post-deposit call bundle.
    /// @param target Allowlisted contract to call. It gets an allowance of `amount` for the call.
    /// @param data Calldata, for example `deposit(amount, recipient)` on an ERC-4626 vault.
    struct Call {
        address target;
        bytes data;
    }

    /// @notice What to settle.
    /// @param sessionId OpenRampKit session id (see the TypeScript `sessionIdToBytes32`). Never zero.
    /// @param token ERC-20 token to settle.
    /// @param amount Exact amount of `token`, in base units.
    /// @param recipient Who gets the funds, or on whose behalf the call bundle acts.
    /// @param calls Optional call bundle. Empty: `amount` goes to `recipient`.
    struct Settlement {
        bytes32 sessionId;
        address token;
        uint256 amount;
        address recipient;
        Call[] calls;
    }

    /// @notice The server authorization for a settlement. Ignored by `settle` when `intentSigner` is zero.
    /// @param payer The only address that may use this intent, or zero for any caller.
    /// @param minAmount The lowest `amount` the server accepts.
    /// @param deadline Unix time after which the intent is not valid.
    /// @param signature EIP-712 signature of `intentSigner` (EOA or ERC-1271 contract).
    struct Intent {
        address payer;
        uint256 minAmount;
        uint256 deadline;
        bytes signature;
    }

    /// @notice The stored record of a settled session.
    struct Receipt {
        address payer;
        uint64 settledAt;
        address token;
        address recipient;
        uint256 amount;
    }

    // ------------------------------------------------------------------ constants

    /// @notice EIP-712 type hash of `Call`.
    bytes32 public constant CALL_TYPEHASH = keccak256("Call(address target,bytes data)");

    /// @notice EIP-712 type hash of the signed intent.
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "SettlementIntent(bytes32 sessionId,address payer,address token,address recipient,uint256 minAmount,Call[] calls,uint256 deadline)Call(address target,bytes data)"
    );

    // ------------------------------------------------------------------ storage

    /// @notice Address whose EIP-712 signature authorizes settlements. Zero turns intents off
    /// (then `settle` is open to any payer, and `settleFromBalance` is disabled).
    address public intentSigner;

    /// @notice Contracts that a call bundle may call.
    mapping(address target => bool allowed) public isAllowedTarget;

    mapping(bytes32 sessionId => Receipt) private _receipts;

    // ------------------------------------------------------------------ events

    /// @notice A session settled. The server verifies deposits with this event.
    /// @param sessionId The OpenRampKit session id.
    /// @param payer `msg.sender` of the settlement (the user's wallet, or a solver).
    /// @param recipient Who got the funds, or on whose behalf the call bundle acted.
    /// @param token The settled token.
    /// @param amount The settled amount, in base units.
    /// @param callsHash EIP-712 hash of the call bundle (`hashCalls`); the hash of an empty array when none.
    event Settled(
        bytes32 indexed sessionId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 callsHash
    );

    /// @notice The intent signer changed.
    event IntentSignerUpdated(address indexed previousSigner, address indexed newSigner);

    /// @notice A call target was added to or removed from the allowlist.
    event AllowedTargetUpdated(address indexed target, bool allowed);

    /// @notice The owner recovered tokens that were sent to the contract by mistake.
    event Swept(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------ errors

    error ZeroSessionId();
    error ZeroAddress();
    error ZeroAmount();
    error NotAContract(address account);
    error AlreadySettled(bytes32 sessionId);
    error IntentRequired();
    error IntentExpired(uint256 deadline);
    error InvalidSignature();
    error PayerMismatch(address expected, address actual);
    error AmountBelowMinimum(uint256 amount, uint256 minAmount);
    error TargetNotAllowed(address target);
    error InsufficientBalance(uint256 available, uint256 needed);
    error UnsupportedToken(address token);
    error CallFailed(uint256 index, bytes reason);
    error BalanceInvariant(uint256 balance, uint256 baseline);
    error RenounceDisabled();

    // ------------------------------------------------------------------ constructor

    /// @param initialOwner Owner (use a multisig in production).
    /// @param initialSigner Intent signer, or zero to turn intents off.
    /// @param initialTargets Call targets to allow from the start (for example ERC-4626 vaults).
    constructor(address initialOwner, address initialSigner, address[] memory initialTargets)
        Ownable(initialOwner)
        EIP712("OpenRampSettlement", "1")
    {
        _setIntentSigner(initialSigner);
        for (uint256 i; i < initialTargets.length; ++i) {
            _setAllowedTarget(initialTargets[i], true);
        }
    }

    // ------------------------------------------------------------------ settle

    /// @notice Settle a session with funds pulled from `msg.sender`.
    /// @dev The caller must first approve `s.amount` of `s.token` to this contract.
    /// @param s What to settle.
    /// @param intent Server authorization. Required when `intentSigner` is set; ignored otherwise.
    function settle(Settlement calldata s, Intent calldata intent) external nonReentrant whenNotPaused {
        bool signed = intentSigner != address(0);
        bytes32 callsHash = _checkAndRecord(s, intent, signed);

        IERC20 token = IERC20(s.token);
        uint256 baseline = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), s.amount);
        if (token.balanceOf(address(this)) != baseline + s.amount) revert UnsupportedToken(s.token);

        _deliver(s, token, baseline);
        emit Settled(s.sessionId, msg.sender, s.recipient, s.token, s.amount, callsHash);
    }

    /// @notice Settle a session with tokens that a bridge or solver already sent to this contract.
    /// @dev Always needs a valid intent, because anyone can call it. Use it in the same transaction as
    /// the transfer in, when possible. The intent binds the recipient, so a front-runner can only
    /// complete the settlement as the server intended.
    /// @param s What to settle.
    /// @param intent Server authorization (required).
    function settleFromBalance(Settlement calldata s, Intent calldata intent) external nonReentrant whenNotPaused {
        if (intentSigner == address(0)) revert IntentRequired();
        bytes32 callsHash = _checkAndRecord(s, intent, true);

        IERC20 token = IERC20(s.token);
        uint256 balance = token.balanceOf(address(this));
        if (balance < s.amount) revert InsufficientBalance(balance, s.amount);

        _deliver(s, token, balance - s.amount);
        emit Settled(s.sessionId, msg.sender, s.recipient, s.token, s.amount, callsHash);
    }

    // ------------------------------------------------------------------ views

    /// @notice The record of a settled session. `settledAt` is zero when the session did not settle.
    function receiptOf(bytes32 sessionId) external view returns (Receipt memory) {
        return _receipts[sessionId];
    }

    /// @notice True when the session already settled.
    function isSettled(bytes32 sessionId) external view returns (bool) {
        return _receipts[sessionId].settledAt != 0;
    }

    /// @notice The EIP-712 domain separator of this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 hash of a call bundle, as used in the intent and in `Settled`.
    function hashCalls(Call[] calldata calls) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].target, keccak256(calls[i].data)));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @notice The EIP-712 digest that `intentSigner` signs for a settlement.
    /// @param s The settlement. `s.amount` is not part of the digest; `minAmount` is.
    function intentDigest(Settlement calldata s, address payer, uint256 minAmount, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _intentDigest(s, payer, minAmount, deadline, hashCalls(s.calls));
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set the intent signer. Zero turns intents off.
    function setIntentSigner(address newSigner) external onlyOwner {
        _setIntentSigner(newSigner);
    }

    /// @notice Add or remove a call target.
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        _setAllowedTarget(target, allowed);
    }

    /// @notice Stop new settlements (for example during an incident).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Allow settlements again.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens that were sent to this contract without a settlement.
    /// @dev In the normal flow the contract holds nothing, so this only moves stray funds. A bridge
    /// that pre-funds the contract should call `settleFromBalance` in the same transaction.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    /// @notice Disabled: the contract must always have an owner that can pause it.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ internal

    /// @dev Checks the input and the intent, then records the settlement (effects before interactions).
    function _checkAndRecord(Settlement calldata s, Intent calldata intent, bool signed)
        private
        returns (bytes32 callsHash)
    {
        if (s.sessionId == bytes32(0)) revert ZeroSessionId();
        if (s.recipient == address(0)) revert ZeroAddress();
        if (s.amount == 0) revert ZeroAmount();
        if (s.token.code.length == 0) revert NotAContract(s.token);
        if (_receipts[s.sessionId].settledAt != 0) revert AlreadySettled(s.sessionId);

        callsHash = hashCalls(s.calls);

        if (signed) {
            if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);
            if (intent.payer != address(0) && intent.payer != msg.sender) {
                revert PayerMismatch(intent.payer, msg.sender);
            }
            if (s.amount < intent.minAmount) revert AmountBelowMinimum(s.amount, intent.minAmount);
            bytes32 digest = _intentDigest(s, intent.payer, intent.minAmount, intent.deadline, callsHash);
            if (!SignatureChecker.isValidSignatureNow(intentSigner, digest, intent.signature)) {
                revert InvalidSignature();
            }
        }

        _receipts[s.sessionId] = Receipt({
            payer: msg.sender,
            settledAt: uint64(block.timestamp),
            token: s.token,
            recipient: s.recipient,
            amount: s.amount
        });
    }

    /// @dev Sends `s.amount` to the recipient, or runs the call bundle with it. Any part the bundle
    /// does not use goes to the recipient. The balance never drops below `baseline`.
    function _deliver(Settlement calldata s, IERC20 token, uint256 baseline) private {
        uint256 n = s.calls.length;
        if (n == 0) {
            token.safeTransfer(s.recipient, s.amount);
            return;
        }
        for (uint256 i; i < n; ++i) {
            Call calldata c = s.calls[i];
            address target = c.target;
            if (!isAllowedTarget[target] || target == address(token) || target == address(this)) {
                revert TargetNotAllowed(target);
            }
            token.forceApprove(target, s.amount);
            (bool ok, bytes memory reason) = target.call(c.data);
            if (!ok) revert CallFailed(i, reason);
            token.forceApprove(target, 0);
        }
        uint256 balance = token.balanceOf(address(this));
        if (balance < baseline) revert BalanceInvariant(balance, baseline);
        uint256 leftover = balance - baseline;
        if (leftover != 0) token.safeTransfer(s.recipient, leftover);
    }

    function _intentDigest(Settlement calldata s, address payer, uint256 minAmount, uint256 deadline, bytes32 callsHash)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(INTENT_TYPEHASH, s.sessionId, payer, s.token, s.recipient, minAmount, callsHash, deadline)
            )
        );
    }

    function _setIntentSigner(address newSigner) private {
        emit IntentSignerUpdated(intentSigner, newSigner);
        intentSigner = newSigner;
    }

    function _setAllowedTarget(address target, bool allowed) private {
        if (allowed && target.code.length == 0) revert NotAContract(target);
        isAllowedTarget[target] = allowed;
        emit AllowedTargetUpdated(target, allowed);
    }
}
