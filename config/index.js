'use strict';

require('dotenv').config();

const config = {
  // Telegram
  botToken: process.env.BOT_TOKEN || '',
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number),

  // USDT deposit addresses (Binance Deposit addresses)
  usdtTrc20Address: process.env.USDT_TRC20_ADDRESS || '',
  usdtBep20Address: process.env.USDT_BEP20_ADDRESS || '',
  // V167: Ethereum and Solana receiving addresses (your Trust Wallet addresses for those networks).
  usdtErc20Address: process.env.USDT_ERC20_ADDRESS || '',
  usdtSolAddress:   process.env.USDT_SOL_ADDRESS   || '',
  // V167: how payments are verified. 'chain' (default) = straight from the blockchain, Binance is never called.
  // 'binance' = the old Binance API path (needs BINANCE_API_KEY/SECRET).
  paymentVerify:    (process.env.PAYMENT_VERIFY || 'chain').toLowerCase() === 'binance' ? 'binance' : 'chain',
  usdtTonAddress:   process.env.USDT_TON_ADDRESS   || '',
  // Optional. Binance issues a unique TON address per account and needs no
  // memo, so this is normally left empty — it exists for exchanges that do use
  // one, and nothing is shown to the customer unless it is set.
  usdtTonMemo:      process.env.USDT_TON_MEMO      || '',

  // Binance Spot API (Enable Reading only — for deposit history lookup)
  // V166.8: Binance Pay is switched OFF until the Binance problem is fixed. Set BINANCE_PAY_ENABLED=true to turn it back on.
  binancePayEnabled: String(process.env.BINANCE_PAY_ENABLED || '').toLowerCase() === 'true',
  binanceId:        process.env.BINANCE_ID         || '',
  binanceApiKey:    process.env.BINANCE_API_KEY    || '',
  binanceApiSecret: process.env.BINANCE_API_SECRET || '',

  // CryptoBot (Telegram @CryptoBot — wallet top-ups)
  cryptobotToken:    process.env.CRYPTOBOT_TOKEN    || '',
  cryptobotBotUrl:   process.env.CRYPTOBOT_BOT_URL  || '', // e.g. https://t.me/DIGISELLABOT
  publicBaseUrl:     process.env.PUBLIC_BASE_URL    || '', // e.g. https://digitrust.up.railway.app

  // Webhook
  webhookPort: parseInt(process.env.WEBHOOK_PORT || '8080', 10),
  webhookHost: process.env.WEBHOOK_HOST || '0.0.0.0',

  // Join gate
  requiredGroupId: process.env.REQUIRED_GROUP_ID || '',
  requiredGroupLink: process.env.REQUIRED_GROUP_LINK || '',
  requiredChannelId: process.env.REQUIRED_CHANNEL_ID || '',
  requiredChannelLink: process.env.REQUIRED_CHANNEL_LINK || '',

  // Notifications
  updatesChannelId: process.env.UPDATES_CHANNEL_ID || '',
  updatesGroupId:   process.env.UPDATES_GROUP_ID   || '',

  // Store
  storeName: process.env.STORE_NAME || 'DIGITRUST Store',
  supportUsername: process.env.SUPPORT_USERNAME || 'Aymenau12',
  minDeposit: parseFloat(process.env.MIN_DEPOSIT || '1.00'),
  referralReward: parseFloat(process.env.REFERRAL_REWARD || '0.20'),

  // Database
  dbPath: process.env.DB_PATH || './data/store.db',
};

module.exports = config;
