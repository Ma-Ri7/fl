// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// ============================================================================
// DODOPMMParity.sol — TEST HARNESS (mock, folosit DOAR in teste).
//
// Copie fida a matematicii PMM din DODO V2:
//   https://github.com/DODOEX/contractV2 (Apache-2.0)
//   - contracts/lib/SafeMath.sol
//   - contracts/lib/DecimalMath.sol
//   - contracts/lib/DODOMath.sol
//   - contracts/lib/PMMPricing.sol
// Adaptata la Solidity ^0.8 (aritmetica nativa are aceleasi semantice
// underflow/overflow-revert ca SafeMath 0.6 folosit de DODO).
//
// Scop: testul de PARITATE JS <-> EVM (test/amm.js) — engine-ul off-chain din
// lib/dodo.js trebuie sa produca EXACT aceleasi rezultate pe stari aleatorii.
// ============================================================================

library DODOSafeMath {
    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a, "SUB_ERROR");
        return a - b;
    }

    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a, "ADD_ERROR");
        return c;
    }

    function divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 quotient = a / b;
        uint256 remainder = a - quotient * b;
        if (remainder > 0) return quotient + 1;
        return quotient;
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = x / 2 + 1;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}


library DODODecimalMath {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant ONE2 = 1e36;

    function mulFloor(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * b / ONE;
    }

    function divFloor(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * ONE / b;
    }

    function divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * ONE + b - 1) / b;
    }

    function reciprocalFloor(uint256 i) internal pure returns (uint256) {
        return ONE2 / i;
    }
}


library DODOMath {
    using DODOSafeMath for uint256;

    // Integrate dodo curve from V1 to V2
    // require V0>=V1>=V2>0
    // res = i*delta*(1-k+k(V0^2/V1/V2))
    function _GeneralIntegrate(
        uint256 V0,
        uint256 V1,
        uint256 V2,
        uint256 i,
        uint256 k
    ) internal pure returns (uint256) {
        require(V0 > 0, "TARGET_IS_ZERO");
        uint256 fairAmount = i * (V1 - V2);
        if (k == 0) {
            return fairAmount / DODODecimalMath.ONE;
        }
        uint256 V0V0V1V2 = DODODecimalMath.divFloor(V0 * V0 / V1, V2);
        uint256 penalty = DODODecimalMath.mulFloor(k, V0V0V1V2);
        return DODODecimalMath.ONE.sub(k).add(penalty) * fairAmount / DODODecimalMath.ONE2;
    }

    // V0 = V1*(1+(sqrt-1)/2k)
    function _SolveQuadraticFunctionForTarget(
        uint256 V1,
        uint256 delta,
        uint256 i,
        uint256 k
    ) internal pure returns (uint256) {
        if (k == 0) {
            return V1 + DODODecimalMath.mulFloor(i, delta);
        }
        if (V1 == 0) {
            return 0;
        }
        uint256 sqrt;
        uint256 ki = (4 * k) * i;
        if (ki == 0) {
            sqrt = DODODecimalMath.ONE;
        } else if ((ki * delta) / ki == delta) {
            sqrt = ((ki * delta) / V1 + DODODecimalMath.ONE2).sqrt();
        } else {
            sqrt = (ki / V1 * delta + DODODecimalMath.ONE2).sqrt();
        }
        uint256 premium = DODODecimalMath.divFloor(sqrt.sub(DODODecimalMath.ONE), k * 2).add(DODODecimalMath.ONE);
        return DODODecimalMath.mulFloor(V1, premium);
    }

    function _SolveQuadraticFunctionForTrade(
        uint256 V0,
        uint256 V1,
        uint256 delta,
        uint256 i,
        uint256 k
    ) internal pure returns (uint256) {
        require(V0 > 0, "TARGET_IS_ZERO");
        if (delta == 0) {
            return 0;
        }

        if (k == 0) {
            return DODODecimalMath.mulFloor(i, delta) > V1 ? V1 : DODODecimalMath.mulFloor(i, delta);
        }

        if (k == DODODecimalMath.ONE) {
            uint256 temp;
            uint256 idelta = i * delta;
            if (idelta == 0) {
                temp = 0;
            } else if ((idelta * V1) / idelta == V1) {
                temp = (idelta * V1) / (V0 * V0);
            } else {
                temp = delta * V1 / V0 * i / V0;
            }
            return V1 * temp / temp.add(DODODecimalMath.ONE);
        }

        uint256 part2 = k * V0 / V1 * V0 + i * delta;
        uint256 bAbs = DODODecimalMath.ONE.sub(k) * V1;

        bool bSig;
        if (bAbs >= part2) {
            bAbs = bAbs - part2;
            bSig = false;
        } else {
            bAbs = part2 - bAbs;
            bSig = true;
        }
        bAbs = bAbs / DODODecimalMath.ONE;

        uint256 squareRoot = DODODecimalMath.mulFloor(
            DODODecimalMath.ONE.sub(k) * 4,
            DODODecimalMath.mulFloor(k, V0) * V0
        );
        squareRoot = (bAbs * bAbs + squareRoot).sqrt();

        uint256 denominator = DODODecimalMath.ONE.sub(k) * 2;
        uint256 numerator;
        if (bSig) {
            numerator = squareRoot.sub(bAbs);
            if (numerator == 0) {
                revert("DODOMath: should not be zero");
            }
        } else {
            numerator = bAbs.add(squareRoot);
        }

        uint256 V2 = DODODecimalMath.divCeil(numerator, denominator);
        if (V2 > V1) {
            return 0;
        } else {
            return V1 - V2;
        }
    }
}

library DODOPMMPricing {
    using DODOSafeMath for uint256;

    enum RState {
        ONE,
        ABOVE_ONE,
        BELOW_ONE
    }

    struct PMMState {
        uint256 i;
        uint256 K;
        uint256 B;
        uint256 Q;
        uint256 B0;
        uint256 Q0;
        RState R;
    }

    function sellBaseToken(PMMState memory state, uint256 payBaseAmount)
        internal
        pure
        returns (uint256 receiveQuoteAmount, RState newR)
    {
        if (state.R == RState.ONE) {
            receiveQuoteAmount = _ROneSellBaseToken(state, payBaseAmount);
            newR = RState.BELOW_ONE;
        } else if (state.R == RState.ABOVE_ONE) {
            uint256 backToOnePayBase = state.B0.sub(state.B);
            uint256 backToOneReceiveQuote = state.Q.sub(state.Q0);
            if (payBaseAmount < backToOnePayBase) {
                receiveQuoteAmount = _RAboveSellBaseToken(state, payBaseAmount);
                newR = RState.ABOVE_ONE;
                if (receiveQuoteAmount > backToOneReceiveQuote) {
                    receiveQuoteAmount = backToOneReceiveQuote;
                }
            } else if (payBaseAmount == backToOnePayBase) {
                receiveQuoteAmount = backToOneReceiveQuote;
                newR = RState.ONE;
            } else {
                receiveQuoteAmount = backToOneReceiveQuote.add(
                    _ROneSellBaseToken(state, payBaseAmount.sub(backToOnePayBase))
                );
                newR = RState.BELOW_ONE;
            }
        } else {
            receiveQuoteAmount = _RBelowSellBaseToken(state, payBaseAmount);
            newR = RState.BELOW_ONE;
        }
    }

    function sellQuoteToken(PMMState memory state, uint256 payQuoteAmount)
        internal
        pure
        returns (uint256 receiveBaseAmount, RState newR)
    {
        if (state.R == RState.ONE) {
            receiveBaseAmount = _ROneSellQuoteToken(state, payQuoteAmount);
            newR = RState.ABOVE_ONE;
        } else if (state.R == RState.ABOVE_ONE) {
            receiveBaseAmount = _RAboveSellQuoteToken(state, payQuoteAmount);
            newR = RState.ABOVE_ONE;
        } else {
            uint256 backToOnePayQuote = state.Q0.sub(state.Q);
            uint256 backToOneReceiveBase = state.B.sub(state.B0);
            if (payQuoteAmount < backToOnePayQuote) {
                receiveBaseAmount = _RBelowSellQuoteToken(state, payQuoteAmount);
                newR = RState.BELOW_ONE;
                if (receiveBaseAmount > backToOneReceiveBase) {
                    receiveBaseAmount = backToOneReceiveBase;
                }
            } else if (payQuoteAmount == backToOnePayQuote) {
                receiveBaseAmount = backToOneReceiveBase;
                newR = RState.ONE;
            } else {
                receiveBaseAmount = backToOneReceiveBase.add(
                    _ROneSellQuoteToken(state, payQuoteAmount.sub(backToOnePayQuote))
                );
                newR = RState.ABOVE_ONE;
            }
        }
    }

    function _ROneSellBaseToken(PMMState memory state, uint256 payBaseAmount)
        internal
        pure
        returns (uint256)
    {
        return DODOMath._SolveQuadraticFunctionForTrade(state.Q0, state.Q0, payBaseAmount, state.i, state.K);
    }

    function _ROneSellQuoteToken(PMMState memory state, uint256 payQuoteAmount)
        internal
        pure
        returns (uint256)
    {
        return DODOMath._SolveQuadraticFunctionForTrade(
            state.B0,
            state.B0,
            payQuoteAmount,
            DODODecimalMath.reciprocalFloor(state.i),
            state.K
        );
    }

    function _RBelowSellQuoteToken(PMMState memory state, uint256 payQuoteAmount)
        internal
        pure
        returns (uint256)
    {
        return DODOMath._GeneralIntegrate(
            state.Q0,
            state.Q.add(payQuoteAmount),
            state.Q,
            DODODecimalMath.reciprocalFloor(state.i),
            state.K
        );
    }

    function _RBelowSellBaseToken(PMMState memory state, uint256 payBaseAmount)
        internal
        pure
        returns (uint256)
    {
        return DODOMath._SolveQuadraticFunctionForTrade(state.Q0, state.Q, payBaseAmount, state.i, state.K);
    }

    function _RAboveSellBaseToken(PMMState memory state, uint256 payBaseAmount)
        internal
        pure
        returns (uint256)
    {
        return DODOMath._GeneralIntegrate(state.B0, state.B.add(payBaseAmount), state.B, state.i, state.K);
    }

    function _RAboveSellQuoteToken(PMMState memory state, uint256 payQuoteAmount)
        internal
        pure
        returns (uint256)
    {
        return DODOMath._SolveQuadraticFunctionForTrade(
            state.B0,
            state.B,
            payQuoteAmount,
            DODODecimalMath.reciprocalFloor(state.i),
            state.K
        );
    }
}


/// @dev Harness: expune pricing-ul PMM pentru testul de paritate JS <-> EVM.
contract DODOPMMHarness {
    function sellBaseRaw(
        uint256 i,
        uint256 K,
        uint256 B,
        uint256 Q,
        uint256 B0,
        uint256 Q0,
        uint8 R,
        uint256 payBase
    ) external pure returns (uint256 receiveQuote) {
        DODOPMMPricing.PMMState memory state;
        state.i = i;
        state.K = K;
        state.B = B;
        state.Q = Q;
        state.B0 = B0;
        state.Q0 = Q0;
        state.R = DODOPMMPricing.RState(R);
        (receiveQuote, ) = DODOPMMPricing.sellBaseToken(state, payBase);
    }

    function sellQuoteRaw(
        uint256 i,
        uint256 K,
        uint256 B,
        uint256 Q,
        uint256 B0,
        uint256 Q0,
        uint8 R,
        uint256 payQuote
    ) external pure returns (uint256 receiveBase) {
        DODOPMMPricing.PMMState memory state;
        state.i = i;
        state.K = K;
        state.B = B;
        state.Q = Q;
        state.B0 = B0;
        state.Q0 = Q0;
        state.R = DODOPMMPricing.RState(R);
        (receiveBase, ) = DODOPMMPricing.sellQuoteToken(state, payQuote);
    }

    /// @dev Replică exact DVMStorage.getPMMState() (R=ABOVE, Q0=0, B0 derivat).
    function pmmStateFromReserves(uint256 i, uint256 K, uint256 B, uint256 Q)
        external
        pure
        returns (uint256 b0)
    {
        DODOPMMPricing.PMMState memory state;
        state.i = i;
        state.K = K;
        state.B = B;
        state.Q = Q;
        state.B0 = 0;
        state.Q0 = 0;
        state.R = DODOPMMPricing.RState.ABOVE_ONE;
        state.B0 = DODOMath._SolveQuadraticFunctionForTarget(
            B,
            Q - state.Q0,
            DODODecimalMath.reciprocalFloor(i),
            K
        );
        return state.B0;
    }
}


