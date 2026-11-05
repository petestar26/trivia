import { api, unwrapData } from './api';
export type RewardConfig = {
  version: number;
  daily_enabled: boolean;
  daily_amount: number;
  gift_enabled: boolean;
  gift_amount: number;
  gift_daily_limit: number;
  referral_enabled: boolean;
  referral_amount: number;
  gift_minimum: number;
  updated_at: string;
};
export type RewardSummary = {
  config: RewardConfig;
  wallet: {
    coinAvailability?: {
      spendable: number;
      betOnly: number;
      pendingReview: number;
      reserved: number;
    };
  };
  eligibility: { canClaim: boolean; expiryHours: number | null };
  referralCode: string | null;
  referrals: number;
  qualifiedReferrals: number;
  pendingMinor: number;
  earnedMinor: number;
  today: { id: string; claimed_at: string | null } | null;
  day: string;
  nextCheckInAt: string;
  history: {
    id: string;
    kind: 'DAILY' | 'GIFT' | 'REFERRAL';
    amount: number;
    created_at: string;
    claimed_at: string | null;
  }[];
  hasMore: boolean;
};
export const rewardLabels = {
  DAILY: 'Daily check-in',
  GIFT: 'Gift purchase',
  REFERRAL: 'Referral reward',
};
export const memberGet = async <T>(path: string) => unwrapData(await api.get<T>(path));
export const memberDate = (value: string | null) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Not available';
