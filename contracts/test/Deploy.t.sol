// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {OpenRampSettlement} from "../src/OpenRampSettlement.sol";

contract DeployScriptTest is Test {
    Deploy internal deploy;
    uint256 internal constant KEY = 0xD3910;

    function setUp() public {
        deploy = new Deploy();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(KEY));
    }

    function test_checkConfig_testnetMayHaveNoSigner() public view {
        deploy.checkConfig(421_614, address(0));
        deploy.checkConfig(31_337, address(0));
    }

    function test_checkConfig_mainnetNeedsSigner() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.IntentSignerRequired.selector, 42_161));
        deploy.checkConfig(42_161, address(0));
        deploy.checkConfig(42_161, address(0xBEEF));
    }

    function testFuzz_checkConfig_unknownChainNeedsSigner(uint256 chainId) public {
        vm.assume(!deploy.isTestnet(chainId));
        vm.expectRevert(abi.encodeWithSelector(Deploy.IntentSignerRequired.selector, chainId));
        deploy.checkConfig(chainId, address(0));
    }

    /// One test only: `vm.setEnv` is process-wide, and tests run in parallel.
    function test_run_mainnetNeedsSigner() public {
        vm.chainId(42_161);
        vm.setEnv("SETTLEMENT_INTENT_SIGNER", vm.toString(address(0)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.IntentSignerRequired.selector, 42_161));
        deploy.run();

        vm.setEnv("SETTLEMENT_INTENT_SIGNER", vm.toString(address(0xBEEF)));
        OpenRampSettlement s = deploy.run();
        assertEq(s.intentSigner(), address(0xBEEF));
        assertEq(s.owner(), vm.addr(KEY));
    }
}
