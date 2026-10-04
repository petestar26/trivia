// Catalog only: no addresses, provider calls or spendable credits until an
// explicitly selected provider and its asset/network mapping are integrated.
export const cryptoPaymentCatalog = [
  { symbol: 'USDT', name: 'Tether', network: 'Provider network selection required' },
  { symbol: 'USDC', name: 'USD Coin', network: 'Provider network selection required' },
  { symbol: 'BTC', name: 'Bitcoin', network: 'Bitcoin' },
  { symbol: 'ETH', name: 'Ethereum', network: 'Ethereum' },
  { symbol: 'SOL', name: 'Solana', network: 'Solana' },
].map((asset) => ({ ...asset, available: false, reason: 'Provider integration pending' }));
