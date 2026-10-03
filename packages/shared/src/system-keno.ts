export interface SystemKenoRound {
  id:string;opensAt:number;closesAt:number;endsAt:number;outcome:number[]|null;
  ticket:null|{picks:number[];stakePerNumber:number;stake:number;payout:number|null};
}
export interface SystemKenoSnapshot {
  enabled:boolean;serverTime:number;balance:number;rounds:SystemKenoRound[];
}