type PricedProduct = {
  price_cents: number;
  early_bird_price_cents?: number | null;
  early_bird_ends_at_epoch?: number | null;
};

// Exclusive cutoff: Oct 30, 2026 00:00 America/Los_Angeles (07:00 UTC).
// The offer includes the entire day of October 29.
export const CAP_EARLY_BIRD_END_EPOCH = 1793343600;

export function isEarlyBird(product: PricedProduct, epochSeconds: number): boolean {
  return Number.isFinite(epochSeconds) && Number.isSafeInteger(product.early_bird_ends_at_epoch)
    && Number.isSafeInteger(product.early_bird_price_cents) && product.early_bird_price_cents! >= 0
    && product.early_bird_price_cents! < product.price_cents
    && epochSeconds < product.early_bird_ends_at_epoch!;
}

export function priceAt(product: PricedProduct, epochSeconds: number): number {
  return isEarlyBird(product, epochSeconds) ? product.early_bird_price_cents! : product.price_cents;
}
