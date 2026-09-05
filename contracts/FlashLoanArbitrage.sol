// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFlashPair {
    function factory() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}

interface IPancakeV2Factory {
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address pair);
}

interface ISwapRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IPancakeV3Factory {
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);
}

interface IPancakeV3Pool {
    function factory() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IDODOFlashPool {
    function flashLoan(
        uint256 baseAmount,
        uint256 quoteAmount,
        address assetTo,
        bytes calldata data
    ) external;

    function _BASE_TOKEN_() external view returns (address);

    function _QUOTE_TOKEN_() external view returns (address);

    function getBaseInput() external view returns (uint256);

    function getQuoteInput() external view returns (uint256);
}

interface IDODOSwapPool {
    function _BASE_TOKEN_() external view returns (address);

    function _QUOTE_TOKEN_() external view returns (address);

    function getBaseInput() external view returns (uint256);

    function getQuoteInput() external view returns (uint256);

    function sellBase(address to)
        external
        returns (uint256 receiveQuoteAmount);

    function sellQuote(address to)
        external
        returns (uint256 receiveBaseAmount);
}

/// @title FlashLoanArbitrage
/// @notice Atomic two-leg arbitrage executor on BNB Chain.
/// @dev
/// Flash sources:
///   - PancakeSwap V2 FlashSwap
///   - DODO V2 DVM/DPP/DSP flashLoan
///
/// Swap legs:
///   - UniswapV2-style router
///   - PancakeSwap V3 pool
///   - DODO V2 pool
///
/// Important:
///   - The contract does not assume that a DODO flashloan is universally free.
///   - Profit is calculated against the token balance that existed before
///     execution, so pre-existing funds cannot be counted as profit.
///   - Leg B receives only the actual output delta produced by Leg A.
///   - All callbacks are bound to the currently active flash source / V3 pool.
contract FlashLoanArbitrage is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Canonical PancakeSwap BSC addresses
    // ---------------------------------------------------------------------

    address internal constant PANCAKE_V2_FACTORY =
        0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;

    address internal constant PANCAKE_V3_FACTORY =
        0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;

    // PancakeSwap V2 pair fee:
    // amountIn * 9975 / 10000
    uint256 internal constant V2_FEE_NUMERATOR = 9975;
    uint256 internal constant V2_FEE_DENOMINATOR = 10000;

    // Full-range PancakeSwap V3 sqrt-price limits.
    uint160 internal constant MIN_SQRT =
        4295128740;

    uint160 internal constant MAX_SQRT =
        1461446703485210103287273052203988822378723970341;

    enum LegKind {
        V2_ROUTER,
        V3_POOL,
        DODO_POOL
    }

    struct Leg {
        LegKind kind;
        address target;
        bool zeroForOne;
        address[] path;
    }

    // ---------------------------------------------------------------------
    // Active execution state
    // ---------------------------------------------------------------------

    address public activePair;
    address public activeDodoPool;

    address[2] public activeV3Targets;
    address[2] public activeV3TokenIn;
    address[2] public activeV3TokenOut;
    bool[2] public activeV3ZeroForOne;

    bytes32 public activeDataHash;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ArbitrageExecuted(
        address indexed token,
        uint256 profit,
        address indexed recipient
    );

    event Rescue(
        address indexed token,
        uint256 amount
    );

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor() Ownable(msg.sender) {}

    // ---------------------------------------------------------------------
    // Emergency / administration
    // ---------------------------------------------------------------------

    /// @notice Move tokens accidentally left in the contract to the owner.
    /// @dev This function is intentionally owner-only.
    function rescueToken(
        address token_
    ) external onlyOwner {
        require(
            token_ != address(0),
            "zero-token"
        );

        uint256 bal =
            IERC20(token_).balanceOf(address(this));

        require(
            bal > 0,
            "zero"
        );

        IERC20(token_).safeTransfer(
            owner(),
            bal
        );

        emit Rescue(
            token_,
            bal
        );
    }

    // ---------------------------------------------------------------------
    // PancakeSwap V2 FlashSwap
    // ---------------------------------------------------------------------

    /// @notice Execute a two-leg arbitrage using a PancakeSwap V2 pair
    ///         as the flash liquidity source.
    function flashArbitrage(
        address pair_,
        uint256 amount0Out_,
        uint256 amount1Out_,
        Leg calldata legA_,
        Leg calldata legB_,
        uint256 minProfit_,
        uint256 deadline_
    )
        external
        onlyOwner
        nonReentrant
        returns (uint256 profit)
    {
        require(
            pair_ != address(0),
            "pair-zero"
        );

        require(
            (amount0Out_ > 0) != (amount1Out_ > 0),
            "one-side"
        );

        require(
            minProfit_ > 0,
            "profit-zero"
        );

        require(
            deadline_ >= block.timestamp,
            "expired"
        );

        address token0 =
            IFlashPair(pair_).token0();

        address token1 =
            IFlashPair(pair_).token1();

        require(
            token0 != address(0) &&
            token1 != address(0),
            "bad-pair"
        );

        require(
            token0 != token1,
            "same-token"
        );

        // This entry point is specifically for PancakeSwap V2.
        require(
            IFlashPair(pair_).factory()
                == PANCAKE_V2_FACTORY,
            "not-pancake-v2"
        );

        require(
            IPancakeV2Factory(PANCAKE_V2_FACTORY)
                .getPair(token0, token1)
                == pair_,
            "invalid-pair"
        );

        address tokenIn =
            amount0Out_ > 0
                ? token0
                : token1;

        address tokenOut =
            amount0Out_ > 0
                ? token1
                : token0;

        uint256 amountIn =
            amount0Out_ > 0
                ? amount0Out_
                : amount1Out_;

        uint256 initialTokenInBalance =
            IERC20(tokenIn).balanceOf(address(this));

        uint256 initialTokenOutBalance =
            IERC20(tokenOut).balanceOf(address(this));

        _checkLeg(
            legA_,
            tokenIn,
            tokenOut
        );

        _checkLeg(
            legB_,
            tokenOut,
            tokenIn
        );

        bytes memory data = abi.encode(
            tokenIn,
            tokenOut,
            legA_,
            legB_,
            amountIn,
            minProfit_,
            deadline_,
            initialTokenInBalance,
            initialTokenOutBalance
        );

        activePair = pair_;
        activeDataHash = keccak256(data);

        _setV3Targets(
            legA_,
            legB_,
            tokenIn,
            tokenOut
        );

        IFlashPair(pair_).swap(
            amount0Out_,
            amount1Out_,
            address(this),
            data
        );

        // Callback must have completed successfully.
        // At this point the flashloan has already been repaid.
        uint256 finalTokenInBalance =
            IERC20(tokenIn).balanceOf(address(this));

        require(
            finalTokenInBalance >=
                initialTokenInBalance + minProfit_,
            "no-profit"
        );

        profit =
            finalTokenInBalance -
            initialTokenInBalance;

        _clear();

        // Transfer only the newly generated profit.
        // Pre-existing funds remain untouched.
        IERC20(tokenIn).safeTransfer(
            owner(),
            profit
        );

        emit ArbitrageExecuted(
            tokenIn,
            profit,
            owner()
        );
    }

    /// @notice PancakeSwap V2 FlashSwap callback.
    function pancakeCall(
        address sender_,
        uint256 amount0Out_,
        uint256 amount1Out_,
        bytes calldata data_
    ) external {
        require(
            msg.sender == activePair,
            "!caller"
        );

        require(
            sender_ == address(this),
            "!sender"
        );

        require(
            keccak256(data_) == activeDataHash,
            "!data"
        );

        (
            address tokenIn,
            address tokenOut,
            Leg memory legA,
            Leg memory legB,
            uint256 borrowedAmount,
            uint256 minProfit,
            uint256 deadline,
            uint256 initialTokenInBalance,
            uint256 initialTokenOutBalance
        ) = abi.decode(
            data_,
            (
                address,
                address,
                Leg,
                Leg,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256
            )
        );

        activeDataHash = bytes32(0);

        require(
            block.timestamp <= deadline,
            "expired"
        );

        address pairToken0 =
            IFlashPair(msg.sender).token0();

        address pairToken1 =
            IFlashPair(msg.sender).token1();

        require(
            tokenIn == pairToken0 ||
            tokenIn == pairToken1,
            "bad-token-in"
        );

        require(
            tokenOut ==
                (
                    tokenIn == pairToken0
                        ? pairToken1
                        : pairToken0
                ),
            "bad-token-out"
        );

        require(
            (amount0Out_ > 0) !=
            (amount1Out_ > 0),
            "callback-side"
        );

        uint256 actualBorrowed =
            amount0Out_ > 0
                ? amount0Out_
                : amount1Out_;

        require(
            actualBorrowed == borrowedAmount,
            "borrow-mismatch"
        );

        require(
            IERC20(tokenIn).balanceOf(address(this))
                >=
                initialTokenInBalance +
                borrowedAmount,
            "loan-not-received"
        );

        _checkLeg(
            legA,
            tokenIn,
            tokenOut
        );

        _checkLeg(
            legB,
            tokenOut,
            tokenIn
        );

        // Leg A uses exactly the flash-borrowed amount.
        _execLeg(
            legA,
            tokenIn,
            borrowedAmount,
            deadline
        );

        // Leg B uses ONLY the output delta generated by Leg A.
        uint256 tokenOutAfterLegA =
            IERC20(tokenOut).balanceOf(address(this));

        require(
            tokenOutAfterLegA >=
                initialTokenOutBalance,
            "intermediate-loss"
        );

        uint256 legAOutput =
            tokenOutAfterLegA -
            initialTokenOutBalance;

        require(
            legAOutput > 0,
            "zero-leg-a-output"
        );

        _execLeg(
            legB,
            tokenOut,
            legAOutput,
            deadline
        );

        // PancakeSwap V2 FlashSwap repayment:
        //
        // requiredInput * 9975 / 10000 >= borrowedAmount
        //
        // therefore:
        // ceil(
        //     borrowedAmount * 10000 / 9975
        // )
        uint256 owed =
            _ceilDiv(
                borrowedAmount *
                    V2_FEE_DENOMINATOR,
                V2_FEE_NUMERATOR
            );

        if (amount0Out_ > 0) {
            IERC20(pairToken0).safeTransfer(
                msg.sender,
                owed
            );
        } else {
            IERC20(pairToken1).safeTransfer(
                msg.sender,
                owed
            );
        }

        uint256 finalTokenInBalance =
            IERC20(tokenIn).balanceOf(address(this));

        require(
            finalTokenInBalance >=
                initialTokenInBalance +
                minProfit,
            "profit-check"
        );
    }

    // ---------------------------------------------------------------------
    // DODO V2 FlashLoan
    // ---------------------------------------------------------------------

    /// @notice Execute a two-leg arbitrage using DODO V2 flash liquidity.
    /// @dev Supports DVM/DPP/DSP callback variants.
    function flashArbitrageDodo(
        address dodoPool_,
        uint256 baseAmount_,
        uint256 quoteAmount_,
        address tokenIn_,
        address tokenOut_,
        address dodoBase_,
        address dodoQuote_,
        Leg calldata legA_,
        Leg calldata legB_,
        uint256 minProfit_,
        uint256 deadline_
    )
        external
        onlyOwner
        nonReentrant
        returns (uint256 profit)
    {
        require(
            dodoPool_ != address(0),
            "pool-zero"
        );

        require(
            baseAmount_ > 0 ||
            quoteAmount_ > 0,
            "!amount"
        );

        require(
            (baseAmount_ > 0) !=
            (quoteAmount_ > 0),
            "one-side"
        );

        require(
            tokenIn_ != address(0) &&
            tokenOut_ != address(0),
            "bad-token"
        );

        require(
            tokenIn_ != tokenOut_,
            "same-token"
        );

        require(
            minProfit_ > 0,
            "profit-zero"
        );

        require(
            deadline_ >= block.timestamp,
            "expired"
        );

        address actualBase =
            IDODOFlashPool(dodoPool_)._BASE_TOKEN_();

        address actualQuote =
            IDODOFlashPool(dodoPool_)._QUOTE_TOKEN_();

        require(
            actualBase == dodoBase_,
            "base-mismatch"
        );

        require(
            actualQuote == dodoQuote_,
            "quote-mismatch"
        );

        require(
            actualBase != actualQuote &&
            actualBase != address(0) &&
            actualQuote != address(0),
            "bad-dodo-pool"
        );

        if (baseAmount_ > 0) {
            require(
                tokenIn_ == actualBase &&
                tokenOut_ == actualQuote,
                "side-base"
            );
        } else {
            require(
                tokenIn_ == actualQuote &&
                tokenOut_ == actualBase,
                "side-quote"
            );
        }

        uint256 borrowedAmount =
            baseAmount_ > 0
                ? baseAmount_
                : quoteAmount_;

        uint256 initialTokenInBalance =
            IERC20(tokenIn_).balanceOf(address(this));

        uint256 initialTokenOutBalance =
            IERC20(tokenOut_).balanceOf(address(this));

        _checkLeg(
            legA_,
            tokenIn_,
            tokenOut_
        );

        _checkLeg(
            legB_,
            tokenOut_,
            tokenIn_
        );

        bytes memory data = abi.encode(
            tokenIn_,
            tokenOut_,
            dodoBase_,
            dodoQuote_,
            baseAmount_,
            quoteAmount_,
            borrowedAmount,
            legA_,
            legB_,
            minProfit_,
            deadline_,
            initialTokenInBalance,
            initialTokenOutBalance
        );

        activeDodoPool = dodoPool_;
        activeDataHash = keccak256(data);

        _setV3Targets(
            legA_,
            legB_,
            tokenIn_,
            tokenOut_
        );

        IDODOFlashPool(dodoPool_).flashLoan(
            baseAmount_,
            quoteAmount_,
            address(this),
            data
        );

        uint256 finalTokenInBalance =
            IERC20(tokenIn_).balanceOf(address(this));

        require(
            finalTokenInBalance >=
                initialTokenInBalance +
                minProfit_,
            "no-profit"
        );

        profit =
            finalTokenInBalance -
            initialTokenInBalance;

        _clear();

        IERC20(tokenIn_).safeTransfer(
            owner(),
            profit
        );

        emit ArbitrageExecuted(
            tokenIn_,
            profit,
            owner()
        );
    }

    function _dodoCall(
        address sender_,
        uint256 baseAmount_,
        uint256 quoteAmount_,
        bytes calldata data_
    ) internal {
        require(
            msg.sender == activeDodoPool,
            "!caller"
        );

        require(
            sender_ == address(this),
            "!sender"
        );

        require(
            keccak256(data_) == activeDataHash,
            "!data"
        );

        (
            address tokenIn,
            address tokenOut,
            address baseToken,
            address quoteToken,
            uint256 expectedBaseAmount,
            uint256 expectedQuoteAmount,
            uint256 borrowedAmount,
            Leg memory legA,
            Leg memory legB,
            uint256 minProfit,
            uint256 deadline,
            uint256 initialTokenInBalance,
            uint256 initialTokenOutBalance
        ) = abi.decode(
            data_,
            (
                address,
                address,
                address,
                address,
                uint256,
                uint256,
                uint256,
                Leg,
                Leg,
                uint256,
                uint256,
                uint256,
                uint256
            )
        );

        activeDataHash = bytes32(0);

        require(
            block.timestamp <= deadline,
            "expired"
        );

        require(
            baseAmount_ == expectedBaseAmount &&
            quoteAmount_ == expectedQuoteAmount,
            "loan-mismatch"
        );

        require(
            (baseAmount_ > 0) !=
            (quoteAmount_ > 0),
            "callback-side"
        );

        require(
            borrowedAmount ==
                (
                    baseAmount_ > 0
                        ? baseAmount_
                        : quoteAmount_
                ),
            "borrowed-mismatch"
        );

        address actualBase =
            IDODOFlashPool(msg.sender)._BASE_TOKEN_();

        address actualQuote =
            IDODOFlashPool(msg.sender)._QUOTE_TOKEN_();

        require(
            actualBase == baseToken &&
            actualQuote == quoteToken,
            "pool-token-mismatch"
        );

        require(
            IERC20(tokenIn).balanceOf(address(this))
                >=
                initialTokenInBalance +
                borrowedAmount,
            "loan-not-received"
        );

        _checkLeg(
            legA,
            tokenIn,
            tokenOut
        );

        _checkLeg(
            legB,
            tokenOut,
            tokenIn
        );

        _execLeg(
            legA,
            tokenIn,
            borrowedAmount,
            deadline
        );

        uint256 tokenOutAfterLegA =
            IERC20(tokenOut).balanceOf(address(this));

        require(
            tokenOutAfterLegA >=
                initialTokenOutBalance,
            "intermediate-loss"
        );

        uint256 legAOutput =
            tokenOutAfterLegA -
            initialTokenOutBalance;

        require(
            legAOutput > 0,
            "zero-leg-a-output"
        );

        _execLeg(
            legB,
            tokenOut,
            legAOutput,
            deadline
        );

        // DODO V2 performs its own post-callback reserve/loss check.
        //
        // Return the borrowed assets explicitly. The actual DODO pool
        // determines whether this repayment satisfies its flashloan
        // accounting.
        if (baseAmount_ > 0) {
            IERC20(baseToken).safeTransfer(
                msg.sender,
                baseAmount_
            );
        }

        if (quoteAmount_ > 0) {
            IERC20(quoteToken).safeTransfer(
                msg.sender,
                quoteAmount_
            );
        }

        uint256 finalTokenInBalance =
            IERC20(tokenIn).balanceOf(address(this));

        require(
            finalTokenInBalance >=
                initialTokenInBalance +
                minProfit,
            "profit-check"
        );
    }

    function DVMFlashLoanCall(
        address sender_,
        uint256 baseAmount_,
        uint256 quoteAmount_,
        bytes calldata data_
    ) external {
        _dodoCall(
            sender_,
            baseAmount_,
            quoteAmount_,
            data_
        );
    }

    function DSPFlashLoanCall(
        address sender_,
        uint256 baseAmount_,
        uint256 quoteAmount_,
        bytes calldata data_
    ) external {
        _dodoCall(
            sender_,
            baseAmount_,
            quoteAmount_,
            data_
        );
    }

    function DPPFlashLoanCall(
        address sender_,
        uint256 baseAmount_,
        uint256 quoteAmount_,
        bytes calldata data_
    ) external {
        _dodoCall(
            sender_,
            baseAmount_,
            quoteAmount_,
            data_
        );
    }

    // ---------------------------------------------------------------------
    // PancakeSwap V3 callback
    // ---------------------------------------------------------------------

    function pancakeV3SwapCallback(
        int256 amount0Delta_,
        int256 amount1Delta_,
        bytes calldata
    ) external {
        require(
            activeDataHash != bytes32(0) ||
            activePair != address(0) ||
            activeDodoPool != address(0),
            "!active"
        );

        require(
            (amount0Delta_ > 0) !=
            (amount1Delta_ > 0),
            "!delta"
        );

        address token0 =
            IPancakeV3Pool(msg.sender).token0();

        address token1 =
            IPancakeV3Pool(msg.sender).token1();

        uint24 poolFee =
            IPancakeV3Pool(msg.sender).fee();

        require(
            token0 != address(0) &&
            token1 != address(0) &&
            token0 != token1,
            "!pool"
        );

        require(
            IPancakeV3Pool(msg.sender).factory()
                == PANCAKE_V3_FACTORY,
            "!factory"
        );

        bool matched;

        for (uint256 i = 0; i < 2; i++) {
            if (
                activeV3Targets[i] == msg.sender &&
                activeV3TokenIn[i] != address(0)
            ) {
                require(
                    activeV3TokenIn[i] ==
                        (
                            amount0Delta_ > 0
                                ? token0
                                : token1
                        ),
                    "!token-in"
                );

                require(
                    activeV3TokenOut[i] ==
                        (
                            amount0Delta_ > 0
                                ? token1
                                : token0
                        ),
                    "!token-out"
                );

                require(
                    activeV3ZeroForOne[i] ==
                        (amount0Delta_ > 0),
                    "!direction"
                );

                require(
                    IPancakeV3Factory(PANCAKE_V3_FACTORY)
                        .getPool(
                            activeV3TokenIn[i],
                            activeV3TokenOut[i],
                            poolFee
                        )
                        == msg.sender,
                    "!canonical-pool"
                );

                matched = true;
                break;
            }
        }

        require(
            matched,
            "!v3pool"
        );

        uint256 owed;
        address owedToken;

        if (amount0Delta_ > 0) {
            owed = uint256(amount0Delta_);
            owedToken = token0;
        } else {
            owed = uint256(amount1Delta_);
            owedToken = token1;
        }

        require(
            owed > 0,
            "!owed"
        );

        IERC20(owedToken).safeTransfer(
            msg.sender,
            owed
        );
    }

    // ---------------------------------------------------------------------
    // Internal leg validation
    // ---------------------------------------------------------------------

    function _setV3Targets(
        Leg calldata a_,
        Leg calldata b_,
        address tokenIn_,
        address tokenOut_
    ) internal {
        delete activeV3Targets;
        delete activeV3TokenIn;
        delete activeV3TokenOut;
        delete activeV3ZeroForOne;

        if (a_.kind == LegKind.V3_POOL) {
            activeV3Targets[0] = a_.target;
            activeV3TokenIn[0] = tokenIn_;
            activeV3TokenOut[0] = tokenOut_;
            activeV3ZeroForOne[0] = a_.zeroForOne;
        }

        if (b_.kind == LegKind.V3_POOL) {
            activeV3Targets[1] = b_.target;
            activeV3TokenIn[1] = tokenOut_;
            activeV3TokenOut[1] = tokenIn_;
            activeV3ZeroForOne[1] = b_.zeroForOne;
        }
    }

    function _checkLeg(
        Leg memory leg_,
        address tokenIn_,
        address tokenOut_
    ) internal view {
        require(
            leg_.target != address(0),
            "target-zero"
        );

        if (leg_.kind == LegKind.V2_ROUTER) {
            require(
                leg_.path.length >= 2,
                "short-path"
            );

            require(
                leg_.path[0] == tokenIn_ &&
                leg_.path[leg_.path.length - 1]
                    == tokenOut_,
                "bad-path"
            );

            return;
        }

        if (leg_.kind == LegKind.V3_POOL) {
            address poolToken0 =
                IPancakeV3Pool(leg_.target).token0();

            address poolToken1 =
                IPancakeV3Pool(leg_.target).token1();

            require(
                poolToken0 != address(0) &&
                poolToken1 != address(0) &&
                poolToken0 != poolToken1,
                "bad-v3-pool"
            );

            require(
                IPancakeV3Pool(leg_.target).factory()
                    == PANCAKE_V3_FACTORY,
                "not-pancake-v3"
            );

            if (leg_.zeroForOne) {
                require(
                    poolToken0 == tokenIn_ &&
                    poolToken1 == tokenOut_,
                    "bad-v3-direction"
                );
            } else {
                require(
                    poolToken1 == tokenIn_ &&
                    poolToken0 == tokenOut_,
                    "bad-v3-direction"
                );
            }

            uint24 poolFee =
                IPancakeV3Pool(leg_.target).fee();

            require(
                IPancakeV3Factory(PANCAKE_V3_FACTORY)
                    .getPool(
                        tokenIn_,
                        tokenOut_,
                        poolFee
                    )
                    == leg_.target,
                "bad-v3-pool"
            );

            return;
        }

        if (leg_.kind == LegKind.DODO_POOL) {
            address baseToken =
                IDODOSwapPool(leg_.target)
                    ._BASE_TOKEN_();

            address quoteToken =
                IDODOSwapPool(leg_.target)
                    ._QUOTE_TOKEN_();

            require(
                baseToken != address(0) &&
                quoteToken != address(0) &&
                baseToken != quoteToken,
                "bad-dodo-pool"
            );

            if (leg_.zeroForOne) {
                require(
                    baseToken == tokenIn_ &&
                    quoteToken == tokenOut_,
                    "bad-dodo-direction"
                );
            } else {
                require(
                    quoteToken == tokenIn_ &&
                    baseToken == tokenOut_,
                    "bad-dodo-direction"
                );
            }

            return;
        }

        revert(
            "bad-leg-kind"
        );
    }

    // ---------------------------------------------------------------------
    // Internal leg execution
    // ---------------------------------------------------------------------

    function _execLeg(
        Leg memory leg_,
        address tokenIn_,
        uint256 amountIn_,
        uint256 deadline_
    ) internal {
        require(
            amountIn_ > 0,
            "!amount"
        );

        require(
            block.timestamp <= deadline_,
            "expired"
        );

        if (leg_.kind == LegKind.V2_ROUTER) {
            IERC20(tokenIn_).forceApprove(
                leg_.target,
                amountIn_
            );

            ISwapRouter(leg_.target)
                .swapExactTokensForTokens(
                    amountIn_,
                    1,
                    leg_.path,
                    address(this),
                    deadline_
                );

            IERC20(tokenIn_).forceApprove(
                leg_.target,
                0
            );

            return;
        }

        if (leg_.kind == LegKind.V3_POOL) {
            IPancakeV3Pool(leg_.target).swap(
                address(this),
                leg_.zeroForOne,
                int256(amountIn_),
                leg_.zeroForOne
                    ? MIN_SQRT
                    : MAX_SQRT,
                ""
            );

            return;
        }

        if (leg_.kind == LegKind.DODO_POOL) {
            address baseToken =
                IDODOSwapPool(leg_.target)
                    ._BASE_TOKEN_();

            address quoteToken =
                IDODOSwapPool(leg_.target)
                    ._QUOTE_TOKEN_();

            if (leg_.zeroForOne) {
                require(
                    tokenIn_ == baseToken,
                    "dodo-base-direction"
                );

                uint256 baseInputBefore =
                    IDODOSwapPool(leg_.target)
                        .getBaseInput();

                require(
                    baseInputBefore == 0,
                    "dodo-preexisting-base-input"
                );

                IERC20(tokenIn_).safeTransfer(
                    leg_.target,
                    amountIn_
                );

                uint256 baseInputAfter =
                    IDODOSwapPool(leg_.target)
                        .getBaseInput();

                require(
                    baseInputAfter == amountIn_,
                    "dodo-input-mismatch"
                );

                IDODOSwapPool(leg_.target)
                    .sellBase(address(this));

                return;
            }

            require(
                tokenIn_ == quoteToken,
                "dodo-quote-direction"
            );

            uint256 quoteInputBefore =
                IDODOSwapPool(leg_.target)
                    .getQuoteInput();

            require(
                quoteInputBefore == 0,
                "dodo-preexisting-quote-input"
            );

            IERC20(tokenIn_).safeTransfer(
                leg_.target,
                amountIn_
            );

            uint256 quoteInputAfter =
                IDODOSwapPool(leg_.target)
                    .getQuoteInput();

            require(
                quoteInputAfter == amountIn_,
                "dodo-input-mismatch"
            );

            IDODOSwapPool(leg_.target)
                .sellQuote(address(this));

            return;
        }

        revert(
            "bad-leg-kind"
        );
    }

    // ---------------------------------------------------------------------
    // Cleanup / math
    // ---------------------------------------------------------------------

    function _clear() internal {
        activePair = address(0);
        activeDodoPool = address(0);

        activeV3Targets[0] = address(0);
        activeV3Targets[1] = address(0);

        activeV3TokenIn[0] = address(0);
        activeV3TokenIn[1] = address(0);

        activeV3TokenOut[0] = address(0);
        activeV3TokenOut[1] = address(0);

        activeV3ZeroForOne[0] = false;
        activeV3ZeroForOne[1] = false;

        activeDataHash = bytes32(0);
    }

    function _ceilDiv(
        uint256 a_,
        uint256 b_
    ) internal pure returns (uint256) {
        require(
            b_ > 0,
            "div-zero"
        );

        return
            a_ == 0
                ? 0
                : ((a_ - 1) / b_) + 1;
    }
}