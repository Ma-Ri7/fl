// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IV3Callee {
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Minimal PancakeSwap-V3-like pool mock with a fixed exchange rate.
///         swap() pays out tokenOut first, then calls the V3 swap callback on the
///         recipient with positive deltas for the input side (same convention as
///         PancakeV3Pool), so the callee sends tokenIn back to the pool.
contract MockV3Pool {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    // tokenOut per tokenIn, scaled 1e18.
    uint256 public immutable outPerIn;

    constructor(address token0_, address token1_, uint256 outPerIn_) {
        require(token0_ != token1_ && token0_ != address(0) && token1_ != address(0), "addr");
        (token0, token1) = token0_ < token1_ ? (token0_, token1_) : (token1_, token0_);
        // Normalize the rate to the canonical (token0, token1) ordering.
        outPerIn = token0_ < token1_ ? outPerIn_ : (1e36 / outPerIn_);
    }

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        require(amountSpecified > 0, "amount");
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut;
        if (zeroForOne) {
            amountOut = (amountIn * outPerIn) / 1e18;
            amount0 = amountSpecified;
            amount1 = -int256(amountOut);
            IERC20(token1).safeTransfer(recipient, amountOut);
            uint256 balBefore = IERC20(token0).balanceOf(address(this));
            IV3Callee(recipient).pancakeV3SwapCallback(amount0, amount1, data);
            require(IERC20(token0).balanceOf(address(this)) - balBefore == amountIn, "!pay0");
        } else {
            amountOut = (amountIn * 1e36) / outPerIn;
            amount0 = -int256(amountOut);
            amount1 = amountSpecified;
            IERC20(token0).safeTransfer(recipient, amountOut);
            uint256 balBefore = IERC20(token1).balanceOf(address(this));
            IV3Callee(recipient).pancakeV3SwapCallback(amount0, amount1, data);
            require(IERC20(token1).balanceOf(address(this)) - balBefore == amountIn, "!pay1");
        }
    }
}
