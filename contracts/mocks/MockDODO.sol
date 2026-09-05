// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IDODOCallee {
    function DVMFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes calldata data) external;
}

/// @notice Minimal DODO DVM-pool mock: free flashloan that calls back the receiver.
contract MockDODO {
    using SafeERC20 for IERC20;

    address public immutable baseToken;
    address public immutable quoteToken;

    constructor(address baseToken_, address quoteToken_) {
        require(baseToken_ != quoteToken_ && baseToken_ != address(0) && quoteToken_ != address(0), "addr");
        baseToken = baseToken_;
        quoteToken = quoteToken_;
    }

    // Anyone may fund the pool (tests use mint + transfer).
    function flashLoan(uint256 baseAmount, uint256 quoteAmount, address assetTo, bytes calldata data) external {
        if (baseAmount > 0) IERC20(baseToken).safeTransfer(assetTo, baseAmount);
        if (quoteAmount > 0) IERC20(quoteToken).safeTransfer(assetTo, quoteAmount);
        IDODOCallee(assetTo).DVMFlashLoanCall(address(this), baseAmount, quoteAmount, data);
    }
}
