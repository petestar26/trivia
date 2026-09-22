/**
 * The address a group invite is redeemed at. The token is bearer-equivalent —
 * whoever holds the link can redeem it — so it is only ever built from the
 * token the API already hands to managers, on demand, and never logged or
 * persisted client-side.
 */
export function inviteLink(token: string): string {
  return `${window.location.origin}/groups/invite/${encodeURIComponent(token)}`;
}
