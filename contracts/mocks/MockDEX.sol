// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPancakeCallee {
    function pancakeCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// @notice Minimal UniV2-style DEX used for unit tests.
///         A single contract represents a liquidity pool AND a router,
///         with PancakeSwap V2 semantics (0.25% fee, flashloan via swap+data).
contract MockDEX {
    using SafeERC20 for IERC20;

    address public token0;
    address public token1;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public constant FEE_N = 9975;
    uint256 public constant FEE_D = 10000;

    constructor(address t0_, address t1_) {
        require(t0_ != t1_ && t0_ != address(0) && t1_ != address(0), "addr");
        (token0, token1) = t0_ < t1_ ? (t0_, t1_) : (t1_, t0_);
    }

    function getReserves() external view returns (uint256 r0, uint256 r1) {
        return (reserve0, reserve1);
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external {
        if (amount0 > 0) IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        reserve0 += amount0;
        reserve1 += amount1;
    }

    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        require(amountIn > 0 && rIn > 0 && rOut > 0, "amounts");
        uint256 amountInWithFee = amountIn * FEE_N;
        uint256 numerator = amountInWithFee * rOut;
        uint256 denominator = rIn * FEE_D + amountInWithFee;
        return numerator / denominator;
    }

    /// @notice Router-like swap for a 2-token path.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2, "len");
        require(
            (path[0] == token0 && path[1] == token1) || (path[0] == token1 && path[1] == token0),
            "path"
        );
        (uint256 rIn, uint256 rOut) = path[0] == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountOut = getAmountOut(amountIn, rIn, rOut);
        require(amountOut >= amountOutMin, "min");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, amountOut);
        _update();
    }

    /// @notice PancakeSwap V2-style flashloan entry (pair.swap with data).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require((amount0Out > 0) != (amount1Out > 0), "one-side");
        require(amount0Out < reserve0 && amount1Out < reserve1, "liq");

        if (amount0Out > 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).safeTransfer(to, amount1Out);

        if (data.length > 0) {
            IPancakeCallee(to).pancakeCall(msg.sender, amount0Out, amount1Out, data);
        }

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0In = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "input");

        uint256 balance0Adjusted = balance0 * FEE_D - amount0In * (FEE_D - FEE_N);
        uint256 balance1Adjusted = balance1 * FEE_D - amount1In * (FEE_D - FEE_N);
        require(balance0Adjusted * balance1Adjusted >= reserve0 * reserve1 * FEE_D * FEE_D, "K");

        _update();
    }

    function _update() internal {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }
}