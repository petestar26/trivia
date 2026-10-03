# Collectible Game Point gifts

The gift collection uses Game Points. Buying has no fee. Sending an owned gift is free. Converting removes the gift permanently and credits 90% of its fixed point value; the remaining 10% is the platform conversion fee. A 100-point gift costs 100 points and converts to 90. Gift values are multiples of ten, so fees are exact whole points.

The catalog starts with Little Rose (20), Coffee Break (50), Golden Heart (100), Lucky Star (250), Blue Diamond (500), and Royal Crown (1,000). These are decorative fixed-value gifts, not investment collectibles. They cannot become Coins or cash. Existing historical Coin-to-Game-Point gift receipts remain unchanged.

Players can buy for their own collection or deliver a purchase directly to an active member of the same group. Delivery transfers ownership and creates an authoritative gift card in that chat in one transaction. Transferring an owned gift does not buy it again or award extra points. Owners retain access through the global Gifts page after leaving a group. Conversion needs explicit confirmation of the fee and net return.

Gift actions require a saved request ID. Exact retries replay the original response. Item versions prevent stale requests after a gift changes hands. Transactions lock accounts, group membership, the owned gift, and the affected wallet in a consistent order. Immutable database receipts bind ownership changes and conversion fees to their Game Point journals; a failed credit rolls the conversion back. All balances still use the existing canonical wallet helper.

Chat reactions are free. Like, Love, Laugh, Wow, Sad, and Angry are independent desired states per user/message. Repeat add/remove requests are idempotent. Account and group membership are checked under locks, and deleted or cross-group messages reject reactions. Socket events trigger authoritative refreshes; periodic refresh and reconnect recovery cover missed events.

Deployment requires the collectible-point-gifts migration, runtime access to its three tables, and GIFT_COLLECTION_ENABLED=true. No Coin or gambling gate is changed by this feature. Regression coverage includes native PostgreSQL accounting and concurrency, fee disclosure, retry receipts, chat rendering, and reaction controls.
