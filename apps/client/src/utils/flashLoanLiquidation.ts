import type { MarketParams } from "executooor-viem";
import type { Address, Hex } from "viem";
import { maxUint256 } from "viem";

import type { LiquidationEncoder } from "./LiquidationEncoder.js";

/**
 * Parameters for encoding a flash-loan-funded zero-capital liquidation.
 */
export interface FlashLoanLiquidationParams {
  /** Morpho Blue contract address. */
  morpho: Address;
  /** The market being liquidated. */
  market: MarketParams;
  /** The borrower being liquidated. */
  borrower: Address;
  /** Amount of collateral to seize. */
  seizableCollateral: bigint;
  /** Amount of loan tokens needed to repay the borrower's debt. */
  repayAmount: bigint;
  /** Treasury address to receive remaining profit. */
  treasury: Address;
  /**
   * Pre-encoded calls that convert collateral into loan tokens.
   * These execute inside the Morpho liquidation callback, after the
   * executor has received the seized collateral.
   *
   * Typically built by iterating through liquidity venues:
   *   venue.convert(encoder, { src: collateral, dst: loanToken, srcAmount })
   *   const conversionCalls = encoder.flush();
   */
  collateralToLoanCalls: Hex[];
}

/**
 * Encodes a zero-capital flash-loan-funded liquidation.
 *
 * Instead of requiring loan tokens upfront, this borrows them from Morpho's
 * flash loan facility (0% fee), uses them to liquidate, converts the seized
 * collateral back to loan tokens via liquidity venues, and repays the flash loan
 * from the conversion proceeds.
 *
 * Execution flow inside the executor contract:
 *
 * ```
 * [Morpho Flash Loan Callback (we receive `repayAmount` of loanToken)]:
 *   1. Approve Morpho to pull loan tokens (for liquidation repayment)
 *   2. morphoBlueLiquidate(borrower, seizableCollateral, ...)
 *      [Liquidation Callback (we receive collateral)]:
 *        3. Convert collateral -> loanToken via liquidity venues
 *      [End Liquidation Callback]
 *   // Now executor holds: original flash loan amount + profit in loanToken
 * [End Flash Loan Callback: Morpho pulls `repayAmount` back]
 *
 * 4. Skim remaining loanToken profit to treasury
 * ```
 *
 * The beauty: at step 2, we pay Morpho `repayAmount` of loan tokens (which we
 * just flash-loaned). Morpho gives us `seizableCollateral` of collateral. In
 * step 3, we convert that collateral back to more loan tokens than we borrowed
 * (because of the Liquidation Incentive Factor). After the flash loan repayment,
 * the surplus is pure profit.
 *
 * IMPORTANT: This function accumulates calls on the encoder. The caller must
 * call encoder.flush() after this to get the final call array.
 *
 * @param encoder - The LiquidationEncoder instance (calls accumulate on it)
 * @param params - Flash loan liquidation parameters
 */
export function encodeFlashLoanLiquidation(
  encoder: LiquidationEncoder,
  params: FlashLoanLiquidationParams,
): void {
  const {
    morpho,
    market,
    borrower,
    seizableCollateral,
    repayAmount,
    treasury,
    collateralToLoanCalls,
  } = params;

  // === Build from innermost callback outward ===

  // Step 3: Collateral -> loanToken conversion calls.
  // These are pre-built by the caller using liquidity venues.
  // They execute during the Morpho liquidation callback, converting
  // seized collateral tokens into loan tokens.
  const liquidationCallbackCalls = collateralToLoanCalls;

  // Step 1-2: Flash loan callback calls.
  // First approve Morpho, then call liquidate with the conversion callback.

  // 1. Approve Morpho to pull loan tokens for the liquidation repayment
  encoder.erc20Approve(market.loanToken, morpho, 0n);
  encoder.erc20Approve(market.loanToken, morpho, maxUint256);

  // 2. Execute the liquidation.
  //    - seizedAssets = seizableCollateral (we want to seize this much)
  //    - repaidShares = 0n (let Morpho calculate shares from seized assets)
  //    - callbackCalls = conversion calls (collateral -> loanToken)
  encoder.morphoBlueLiquidate(
    morpho,
    market,
    borrower,
    seizableCollateral,
    0n,
    liquidationCallbackCalls,
  );

  // Flush to capture all the flash loan callback calls
  const flashLoanCallbackCalls = encoder.flush();

  // Wrap everything in a Morpho flash loan of loan tokens (0% fee).
  // This gives us the loan tokens we need for the liquidation without
  // any upfront capital.
  encoder.blueFlashLoan(morpho, market.loanToken, repayAmount, flashLoanCallbackCalls);

  // Step 4: After the flash loan callback completes and Morpho pulls back
  // the borrowed amount, any surplus loan tokens (the liquidation profit)
  // remain in the executor. Skim them to treasury.
  encoder.erc20Skim(market.loanToken, treasury);
}

/**
 * Encodes a zero-capital flash-loan-funded liquidation WITH a self-funding
 * coinbase tip (for Flashbots submission on non-WETH markets).
 *
 * This combines flash loan liquidation with a nested WETH flash loan for
 * the builder tip. The outer structure:
 *
 * ```
 * [WETH Flash Loan (for tip)]:
 *   unwrap WETH -> ETH
 *   tip coinbase
 *   [LoanToken Flash Loan (for liquidation)]:
 *     approve + liquidate + convert collateral -> loanToken
 *   [End LoanToken Flash Loan]
 *   swap loanToken -> WETH (to repay tip flash loan)
 *   approve WETH for Morpho
 * [End WETH Flash Loan]
 * skim remaining loanToken to treasury
 * ```
 *
 * @param encoder - The LiquidationEncoder instance
 * @param params - Flash loan liquidation parameters
 * @param tipParams - Tip-specific parameters
 */
export function encodeFlashLoanLiquidationWithTip(
  encoder: LiquidationEncoder,
  params: FlashLoanLiquidationParams,
  tipParams: {
    /** WETH address on this chain. */
    weth: Address;
    /** Uniswap V3 SwapRouter address. */
    uniV3Router: Address;
    /** Uniswap V3 swap path from loanToken to WETH (pre-encoded). */
    swapPath: Hex;
    /** Tip amount in ETH (wei). */
    tipAmount: bigint;
  },
): void {
  const {
    morpho,
    market,
    borrower,
    seizableCollateral,
    repayAmount,
    treasury,
    collateralToLoanCalls,
  } = params;
  const { weth, uniV3Router, swapPath, tipAmount } = tipParams;

  const isWethLoan = market.loanToken.toLowerCase() === weth.toLowerCase();

  if (isWethLoan) {
    // WETH loan: flash loan liquidation + tip from WETH profit
    //
    // Flow:
    //   [LoanToken (WETH) Flash Loan]:
    //     approve + liquidate + convert collateral -> WETH
    //   [End Flash Loan: Morpho pulls repayAmount back]
    //   unwrap WETH -> ETH (from surplus profit)
    //   tip coinbase
    //   skim remaining WETH to treasury

    // Build liquidation callback calls
    encoder.erc20Approve(market.loanToken, morpho, 0n);
    encoder.erc20Approve(market.loanToken, morpho, maxUint256);
    encoder.morphoBlueLiquidate(
      morpho,
      market,
      borrower,
      seizableCollateral,
      0n,
      collateralToLoanCalls,
    );
    const flashLoanCb = encoder.flush();

    // Flash loan for zero-capital liquidation
    encoder.blueFlashLoan(morpho, market.loanToken, repayAmount, flashLoanCb);

    // Tip from surplus WETH profit (after flash loan repayment)
    encoder.unwrapETH(weth, tipAmount);
    encoder.tip(tipAmount);

    // Skim remaining WETH to treasury
    encoder.erc20Skim(market.loanToken, treasury);
  } else {
    // Non-WETH loan: nested flash loans (WETH for tip + loanToken for liquidation)

    // === Inner: loanToken flash loan callback ===
    encoder.erc20Approve(market.loanToken, morpho, 0n);
    encoder.erc20Approve(market.loanToken, morpho, maxUint256);
    encoder.morphoBlueLiquidate(
      morpho,
      market,
      borrower,
      seizableCollateral,
      0n,
      collateralToLoanCalls,
    );
    const loanFlashLoanCb = encoder.flush();

    // === Middle: WETH flash loan callback ===
    // 1. Unwrap WETH -> ETH for tip
    encoder.unwrapETH(weth, tipAmount);
    // 2. Tip coinbase
    encoder.tip(tipAmount);
    // 3. Flash loan loanTokens for liquidation
    encoder.blueFlashLoan(morpho, market.loanToken, repayAmount, loanFlashLoanCb);
    // 4. Swap loanToken profit -> WETH to repay WETH flash loan
    // Use exactOutput: need exactly tipAmount of WETH, spend whatever loanToken needed
    encoder.uniV3ExactOutput(uniV3Router, swapPath, tipAmount, maxUint256);
    // 5. Approve Morpho to pull WETH back
    encoder.erc20Approve(weth, morpho, tipAmount);
    const wethFlashLoanCb = encoder.flush();

    // === Outer: WETH flash loan ===
    encoder.blueFlashLoan(morpho, weth, tipAmount, wethFlashLoanCb);

    // Skim remaining loan token profit to treasury
    encoder.erc20Skim(market.loanToken, treasury);
  }
}
