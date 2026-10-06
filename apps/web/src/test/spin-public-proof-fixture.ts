import type { SpinPublicProof } from '@socialplay/shared';
// Offline mainnet round-1 proof; independently known outcome 19.
export const PUBLIC_PROOF: SpinPublicProof = {
  schema: 'playqube-spin-proof-v1',
  commitment: {
    roundId: 'spin-proof-v2:17',
    rulesId: 'single-zero-rtp90-v2',
    protocol: 'sha256-quicknet-rejection-u32be-v2',
    chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    opensAtMs: 1692803356999,
    closesAtMs: 1692803360999,
    pinnedAtMs: 1692803357099,
    preparedAtMs: 1692803357199,
    seedCommitment: '6b694235aef3515fe96b6d9a374a3341760db211ccf59d8eca266821dd3c8882',
    beaconRound: 1,
    beaconTimeMs: 1692803367000,
  },
  commitmentHash: 'a56b92f705882015cbc0ac155ccc713d41df4b20d27a3347edcbe9bb6db5be01',
  stage: 'DRAWN',
  reveal: {
    seedHex: '0000000000000000000000000000000000000000000000000000000000000000',
    outcome: 19,
    drawnAtMs: 1692803367001,
    beacon: {
      round: 1,
      randomness: '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a',
      signature:
        'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b',
    },
  },
};
