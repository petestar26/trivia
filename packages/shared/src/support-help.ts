/** Source-owned help copy shared by the interface and support assistant. */
export const HELP_ARTICLES = [
  {
    id: 'wallet',
    title: 'Deposits and withdrawals',
    body: 'Open Wallet, choose Deposit or Withdraw, and review the available payment methods. Check the amount, rate and instructions before confirming. Do not send a second payment while an order is pending. Contact support with the order reference if you need help.',
    href: '/wallet',
  },
  {
    id: 'games',
    title: 'Playing our games',
    body: 'Open Play together to choose a group game and read its rules. Group practice points have no cash value and cannot be withdrawn. They are separate from real Birr, reward Birr and older individual practice balances. Watching a room is free; entering requires your own confirmation.',
    href: '/play-together',
  },
  {
    id: 'groups',
    title: 'Playing with a group',
    body: 'The owner publishes a round with fixed rules, an equal entry and a deadline. Each player confirms separately. At least two players are required. Accepted entries are reserved until settlement. Rounds close automatically; winners receive payouts automatically. The platform fee shown before entry applies only to winning profit. Underfilled rounds, no qualifying winner or all-player ties receive full refunds without a fee.',
    href: '/play-together',
  },
  {
    id: 'casino',
    title: 'Casino access',
    body: 'Active signed-in members can access available virtual-money casino games. Provider test credits have no cash value and cannot be withdrawn. If a game fails to open, return to Casino and retry or contact support with the game name. Third-party game screens may offer different languages.',
    href: '/casino',
  },
  {
    id: 'gifts',
    title: 'Sending a gift',
    body: 'Open Gifts, choose a group and recipient, and review the price and funding source before confirming. Practice purchases have no cash value and do not qualify for real-Birr gift or referral rewards. Eligible rewards are credited automatically using the platform’s current reward settings. Support can help with a missing gift.',
    href: '/gifts',
  },
  {
    id: 'language',
    title: 'Changing your language',
    body: 'Choose your language from the header: English, Amharic, Afaan Oromoo, Tigrinya, Somali, Arabic, Swahili or French. Your choice is saved on this device. Interface text and game rules use your selected language. Member names, personal messages and transaction references stay unchanged. Third-party game screens manage their own language options.',
    href: '/support',
  },
] as const;
