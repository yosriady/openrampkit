// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {OpenRampSettlement} from "../../src/OpenRampSettlement.sol";

/// @dev USDC-like token: 6 decimals, open mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Plain ERC-4626 vault over any asset.
contract MockVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Mock Vault", "mvUSDC") ERC4626(asset_) {}
}

/// @dev Takes a 1% fee on every transfer.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @dev A call target that uses only part of its allowance.
contract PartialSpender {
    function pull(IERC20 token, uint256 amount, address to) external {
        token.transferFrom(msg.sender, to, amount);
    }
}

/// @dev A call target that reverts with a message.
contract RevertingTarget {
    function boom() external pure {
        revert("boom");
    }
}

/// @dev A call target that tries to pull more than the settled amount (other people's funds).
contract GreedyTarget {
    function steal(IERC20 token, uint256 amount) external {
        // The contract approved only the settled amount, so this pulls what it can in two steps
        // if the allowance were not reset. It asks for the allowance plus the extra balance.
        token.transferFrom(msg.sender, address(this), amount);
    }
}

/// @dev A call target that tries to re-enter the settlement contract.
contract ReentrantTarget {
    OpenRampSettlement public immutable settlement;

    constructor(OpenRampSettlement s) {
        settlement = s;
    }

    function reenter(OpenRampSettlement.Settlement calldata s) external {
        OpenRampSettlement.Intent memory none;
        settlement.settle(s, none);
    }
}
