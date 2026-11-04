export interface SystemKenoTicket {
  picks: number[];
  stakePerNumber: number;
  stake: number;
  payout: number | null;
}
export interface SystemKenoRound {
  id: string;
  opensAt: number;
  closesAt: number;
  endsAt: number;
  outcome: number[] | null;
  ticket: SystemKenoTicket | null;
  tickets?: (SystemKenoTicket & { slot: number })[];
}
export interface SystemKenoSnapshot {
  enabled: boolean;
  serverTime: number;
  balance: number;
  rounds: SystemKenoRound[];
  maxTickets?: number;
}
