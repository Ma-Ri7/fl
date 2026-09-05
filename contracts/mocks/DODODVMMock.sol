// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Minimal DODO DVM pool mock with real PMM state.
// Replicates the flashLoan + callback flow of DODO V2 (DVM contractV2).
// PMM math is intentionally simplified — fee is 0%, the pool only requires
// that borrowed amounts are returned (mirrors MockDODO behavior for fork testing).

interface IDODOCallee {
    function DVMFlashLoanCall(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) external;
}

contract DODODVMMock {
    using SafeERC20 for IERC20;

    address public immutable _BASE_TOKEN_;
    address public immutable _QUOTE_TOKEN_;

    // PMM state (for inspection; flashloan repayment is fee-free in this mock)
    uint256 public i;      // oracle price
    uint256 public K;      // slippage factor
    uint256 public B;      // base balance target
    uint256 public Q;      // quote balance target

    // Recorded balances at the start of each flashLoan call (for repayment check)
    uint256 private _baseBefore;
    uint256 private _quoteBefore;

    constructor(
        address baseToken_,
        address quoteToken_,
        uint256 i_,
        uint256 K_,
        uint256 B_,
        uint256 Q_
    ) {
        require(
            baseToken_ != quoteToken_ &&
            baseToken_ != address(0) &&
            quoteToken_ != address(0),
            "addr"
        );
        _BASE_TOKEN_ = baseToken_;
        _QUOTE_TOKEN_ = quoteToken_;
        i = i_;
        K = K_;
        B = B_;
        Q = Q_;
    }

    /// @dev Anyone may fund (tests use mint + transfer).
    function flashLoan(
        uint256 baseAmount,
        uint256 quoteAmount,
        address assetTo,
        bytes calldata data
    ) external {
        require(
            (baseAmount > 0) != (quoteAmount > 0),
            "one-side"
        );
        // Record balances before the flash loan (for post-callback repayment check)
        _baseBefore = IERC20(_BASE_TOKEN_).balanceOf(address(this));
        _quoteBefore = IERC20(_QUOTE_TOKEN_).balanceOf(address(this));
        if (baseAmount > 0) {
            IERC20(_BASE_TOKEN_).safeTransfer(assetTo, baseAmount);
        }
        if (quoteAmount > 0) {
            IERC20(_QUOTE_TOKEN_).safeTransfer(assetTo, quoteAmount);
        }
        IDODOCallee(assetTo).DVMFlashLoanCall(
            msg.sender,
            baseAmount,
            quoteAmount,
            data
        );
        // Post-callback: borrowed assets must be returned (fee-free mock).
        // Compare against balances recorded at the start of the flashLoan call.
        uint256 baseBal = IERC20(_BASE_TOKEN_).balanceOf(address(this));
        uint256 quoteBal = IERC20(_QUOTE_TOKEN_).balanceOf(address(this));
        require(
            baseBal >= _baseBefore && quoteBal >= _quoteBefore,
            "dodo-repay"
        );
    }

    // Compatibility stubs (not used by the arbitrage contract).
    function getBaseInput() external pure returns (uint256) { return 0; }
    function getQuoteInput() external pure returns (uint256) { return 0; }
}
