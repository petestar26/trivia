/** New ETB_V1 agent/P2P requests only. Integers are santim (100 = 1 ETB).
 * These floors never override a stricter agent, eligibility or technical limit.
 * Crypto, legacy USD quotes and existing accepted payment snapshots are separate. */
export const ETB_P2P_REQUIREMENTS = Object.freeze({
  version: 'ETB_P2P_20261117',
  depositMinMinor: 10_000,
  withdrawalMinMinor: 50_000,
  minorUnitsPerEtb: 100,
});
export const PAYMENT_REQUIREMENTS_PATH = '/payment-requirements';
export function etbP2pMinimum(direction: 'deposit' | 'withdrawal'): number {
  return direction === 'deposit' ? ETB_P2P_REQUIREMENTS.depositMinMinor : ETB_P2P_REQUIREMENTS.withdrawalMinMinor;
}
