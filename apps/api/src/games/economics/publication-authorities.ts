/** Trust material is deployment policy, never accepted from a proof or database.
 * Real authorities require separate approval of identity, key custody, clock
 * accuracy, certificate rotation/revocation and permitted service usage.
 */
export interface PublicationAuthority {
  readonly id: string;
  readonly rootCertificatePem: string;
  readonly signerCertificatePem: string;
  readonly signerCertificateSha256: string;
  readonly policyOid: string;
  readonly maxAccuracyMs: number;
}

// No production TSA has been approved. Default verification must fail closed.
export const PUBLICATION_AUTHORITIES: readonly PublicationAuthority[] = Object.freeze([]);
