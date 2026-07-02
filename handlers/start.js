'use strict';

const db      = require('../database/queries');
const session = require('./session');
const { mainMenuKb, backKb, languagePickerKb } = require('../utils/keyboard');
const { t } = require('../utils/i18n');
const { formatReward } = require('../utils/format');

async function sendMainMenu(bot, chatId, userName = '', userId = null) {
  const storeName = db.getSetting('store_name', 'DIGITRUST Store');
  const greeting  = userName ? `, <b>${userName}</b>` : '';
  const lang      = userId ? db.getUserLanguage(userId) : 'en';
  const welcomeKey = db.getSetting(`welcome_message_${lang}`, '') ||
                     db.getSetting('welcome_message', 'Buy premium digital products instantly.');

  const greetText = t(lang, 'welcome_greeting').replace('{store}', storeName).replace('{greeting}', greeting);
  const chooseText = t(lang, 'welcome_choose');

  await bot.sendMessage(
    chatId,
    `${greetText}\n\n${welcomeKey}\n\n${chooseText}`,
    { parse_mode: 'HTML', reply_markup: mainMenuKb(lang) }
  );
}

// Show language picker (called on first /start or from menu)
async function showLanguagePicker(bot, chatId, messageId = null) {
  const text = t('en', 'pick_language');
  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: languagePickerKb()
    });
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML', reply_markup: languagePickerKb()
    });
  }
}

async function handleStart(bot, msg, args) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  session.clear(userId);

  // Handle referral deep-link: /start ref_123456
  if (args && args.startsWith('ref_')) {
    // Check if referral system is enabled
    const referralEnabled = db.getSetting('referral_enabled', '1') === '1';
    if (!referralEnabled) {
      // Just proceed as normal start (skip referral)
      logger.info(`Referral attempt blocked (system off): user ${userId}, referrer ${args}`);
      // Continue normal /start flow below
    } else {
    const referrerId = parseInt(args.split('_')[1], 10);
    if (!isNaN(referrerId) && referrerId !== userId) {
      // Check if VIP is "new only" — existing customers can't refer for VIP unlock
      const vipNewOnly = db.getSetting('vip_new_only', '0') === '1';
      const referrerOrders = db.getUserOrders ? db.getUserOrders(referrerId) : [];
      const referrerIsOld = referrerOrders.some(o => o.status === 'delivered');

      const result = db.recordReferral(referrerId, userId);
      if (result && result.success) {
        // Notify the referrer of the new invite
        try {
          const newReferrals = db.countReferrals(referrerId);
          const VIP_LIMIT = parseInt(db.getSetting('vip_limit', '1000'), 10);
          const totalVips = db.countVIPs();
          const slotsLeft = Math.max(0, VIP_LIMIT - totalVips);
          const invitedName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || `User ${userId}`);

          let notifText =
            `🎉 <b>New Friend Joined!</b>\n\n` +
            `👤 ${invitedName} joined via your invite link.\n\n` +
            `📈 <b>Your team:</b> ${newReferrals}/3 friends`;

          // If they have 3 referrals AND at least one has purchased, unlock VIP
          const hasInviteePurchased = db.hasAnyInviteePurchased(referrerId);
          // Block existing customers from VIP if vip_new_only is enabled
          const vipNewOnlyBlock = vipNewOnly && referrerIsOld;
          if (newReferrals >= 3 && !db.isVIP(referrerId) && slotsLeft > 0 && hasInviteePurchased && !vipNewOnlyBlock) {
            const vipSystemOpen = db.getSetting('vip_system_enabled', '1') === '1';
            if (vipSystemOpen) {
              db.unlockVIP(referrerId);
              notifText += `\n\n👑 <b>CONGRATULATIONS! You unlocked VIP for LIFE!</b>\n\n` +
                `🎁 You now have:\n` +
                `💸 5% discount on every purchase forever\n` +
                `🚀 Early access to new products\n` +
                `⚡️ Priority support`;
            }
          } else if (newReferrals >= 3 && !hasInviteePurchased) {
            notifText += `\n\n⏳ <b>One step away!</b>\nVIP unlocks when at least one of your friends makes a purchase.`;
          } else if (newReferrals < 3) {
            const need = 3 - newReferrals;
            notifText += `\n🎯 <b>${need} more friend(s)</b> needed to unlock VIP for life!`;
          }

          await bot.sendMessage(referrerId, notifText, { parse_mode: 'HTML' });
        } catch (e) {
          // Referrer may have blocked bot, ignore
        }
      }
    }
    } // end else (referral enabled)
  }

  // Maintenance gate (admins bypass)
  const maintenance = db.getSetting('maintenance_mode', '0');
  const config = require('../config');
  if (maintenance === '1' && !config.adminIds.includes(userId)) {
    await bot.sendMessage(
      chatId,
      '🔧 <b>Store is under maintenance.</b>\n\nPlease check back later.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // First time user? → show language picker
  const user = db.getUser(userId);
  if (!user || !user.language) {
    await showLanguagePicker(bot, chatId);
    return;
  }

  // Handle product deep-link: /start p_5 → show product detail
  if (args && args.startsWith('p_')) {
    const productId = parseInt(args.split('_')[1], 10);
    if (!isNaN(productId)) {
      const products = require('./products');
      await products.showProductDetail(bot, chatId, productId);
      return;
    }
  }

  // Show VIP intro only on FIRST start (no orders yet, never seen intro)
  const seenVipIntro = db.getSetting(`vip_intro_seen_${userId}`, '0') === '1';
  if (!seenVipIntro && !db.isVIP(userId)) {
    db.setSetting(`vip_intro_seen_${userId}`, '1');
    await bot.sendMessage(chatId,
      `👑 <b>WELCOME — Become a VIP!</b> 👑\n\n` +
      `🚨 <b>Limited time:</b> ⏳ VIP closes at <b>1,000 customers</b>\n\n` +
      `Invite only <b>3 friends</b> and unlock VIP <b>forever</b>!\n\n` +
      `🎁 <b>VIP Benefits:</b>\n` +
      `💸 5% discount on every purchase for life\n` +
      `🤝 Earn rewards from your team's purchases\n` +
      `🚀 Early access to new and rare products\n` +
      `⚡️ Priority support and faster replies\n\n` +
      `🔥 Secure your VIP status today!`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '👑 Become VIP', callback_data: 'vip_intro_become' }],
        [{ text: '⏭ Skip for now', callback_data: 'vip_intro_skip' }],
      ] } }
    );
    return;
  }

  await sendMainMenu(bot, chatId, msg.from.first_name || '', userId);
}

async function handleReferralMenu(bot, chatId, userId) {
  const stats    = db.getReferralStats(userId);
  const botInfo  = await bot.getMe();
  const link     = `https://t.me/${botInfo.username}?start=ref_${userId}`;
  const reward   = parseFloat(db.getSetting('referral_reward', '0.20'));
  const earned   = stats.rewardedCount * reward;

  await bot.sendMessage(
    chatId,
    `👥 <b>Referral Program</b>\n\n` +
    `Share your link and earn <b>${formatReward(reward)}</b> ` +
    `for every friend who makes their first purchase! ($0.20)\n\n` +
    `🔗 <b>Your Link:</b>\n<code>https://t.me/${botInfo.username}?start=ref_${userId}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 Total referred: <b>${stats.totalReferred}</b>\n` +
    `💰 Total earned:   <b>${formatReward(earned)}</b>\n` +
    `⏳ Pending rewards: <b>${stats.totalReferred - stats.rewardedCount}</b>`,
    { parse_mode: 'HTML', reply_markup: backKb('back_main') }
  );
}

module.exports = { handleStart, sendMainMenu, handleReferralMenu, showLanguagePicker };
