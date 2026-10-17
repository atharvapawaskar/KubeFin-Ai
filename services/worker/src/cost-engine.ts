import { Decimal128 } from 'mongodb';
import type { UsageEvent } from './usage-event.js';
import type { PricingRate } from './pricing-catalog.js';

const MICRO_USD_PER_USD = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;
const MICRO_USD_PER_USD_TIMES_TOKENS_PER_MILLION = MICRO_USD_PER_USD * TOKENS_PER_MILLION;

/** Exact per-event USD cost, preserving all 12 decimal places without floating-point arithmetic. */
export function calculateCostUsd(event: UsageEvent, rate: PricingRate): Decimal128 {
  const { inputTokens, outputTokens } = event.usage;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
    throw new RangeError('Token counts must be safe integers');
  }
  if (
    !Number.isSafeInteger(rate.inputRateMicroUsdPerMillionTokens) ||
    !Number.isSafeInteger(rate.outputRateMicroUsdPerMillionTokens) ||
    rate.inputRateMicroUsdPerMillionTokens < 0 ||
    rate.outputRateMicroUsdPerMillionTokens < 0
  ) {
    throw new RangeError('Pricing rates must be non-negative safe integers');
  }

  const totalMicroUsdNumerator =
    BigInt(inputTokens) * BigInt(rate.inputRateMicroUsdPerMillionTokens) +
    BigInt(outputTokens) * BigInt(rate.outputRateMicroUsdPerMillionTokens);
  const wholeUsd = totalMicroUsdNumerator / MICRO_USD_PER_USD_TIMES_TOKENS_PER_MILLION;
  const fractionalUsd = (totalMicroUsdNumerator % MICRO_USD_PER_USD_TIMES_TOKENS_PER_MILLION)
    .toString()
    .padStart(12, '0');
  return Decimal128.fromString(`${wholeUsd}.${fractionalUsd}`);
}
