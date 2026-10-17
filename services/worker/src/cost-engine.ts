import { Decimal128 } from 'mongodb';
import type { UsageEvent } from './usage-event.js';
import type { PricingRate } from './pricing-catalog.js';

const MICROS_PER_CURRENCY_UNIT = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;
const MICROS_PER_CURRENCY_UNIT_TIMES_TOKENS_PER_MILLION = MICROS_PER_CURRENCY_UNIT * TOKENS_PER_MILLION;

/** Exact per-event amount in the pricing record's currency, preserving 12 decimal places. */
export function calculateCostAmount(event: UsageEvent, rate: PricingRate): Decimal128 {
  const { inputTokens, outputTokens } = event.usage;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
    throw new RangeError('Token counts must be safe integers');
  }
  if (
    !Number.isSafeInteger(rate.inputRateMicrosPerMillionTokens) ||
    !Number.isSafeInteger(rate.outputRateMicrosPerMillionTokens) ||
    rate.inputRateMicrosPerMillionTokens < 0 ||
    rate.outputRateMicrosPerMillionTokens < 0
  ) {
    throw new RangeError('Pricing rates must be non-negative safe integers');
  }

  const totalMicrosNumerator =
    BigInt(inputTokens) * BigInt(rate.inputRateMicrosPerMillionTokens) +
    BigInt(outputTokens) * BigInt(rate.outputRateMicrosPerMillionTokens);
  const wholeCurrency = totalMicrosNumerator / MICROS_PER_CURRENCY_UNIT_TIMES_TOKENS_PER_MILLION;
  const fractionalCurrency = (totalMicrosNumerator % MICROS_PER_CURRENCY_UNIT_TIMES_TOKENS_PER_MILLION)
    .toString()
    .padStart(12, '0');
  return Decimal128.fromString(`${wholeCurrency}.${fractionalCurrency}`);
}
