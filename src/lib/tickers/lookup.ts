import tickerMap from './us-tickers.json';

const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

export function lookupTicker(input: string): string | null {
  const symbol = input.trim().toUpperCase();
  if (!TICKER_RE.test(symbol)) return null;
  return (tickerMap as Record<string, string>)[symbol] ?? null;
}
