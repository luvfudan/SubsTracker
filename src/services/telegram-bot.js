// @ts-check
/**
 * Telegram 交互机器人
 *
 * 与原有 Telegram“通知渠道”分离：
 * - notify/telegram.js 继续负责被动通知
 * - 本文件负责 Telegram Bot Webhook 的主动交互
 *
 * 认证方式：
 * - 默认只允许 config.TG_CHAT_ID 对应的 Chat 使用交互功能
 * - 可用逗号分隔多个 Chat ID（通知发送仍使用第一个 ID）
 * - Webhook 配置后 Telegram 会携带 secret_token，服务端进行校验
 */

import {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  manualRenewSubscription,
  deleteSubscription,
  toggleSubscriptionStatus
} from '../data/subscriptions.js';
import { getConfig, setConfig } from '../data/config.js';
import { formatAmount } from '../core/currency-format.js';
import { addCalendarPeriodInTimezone, formatTimeInTimezone, getTimezoneDateParts, parseDateInputInTimezone } from '../core/time.js';

const SESSION_TTL = 15 * 60;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function telegramUrl(config, method) {
  return `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/${method}`;
}

async function telegramCall(config, method, body = {}) {
  if (!config?.TG_BOT_TOKEN) {
    throw new Error('未配置 TG_BOT_TOKEN');
  }
  const response = await fetch(telegramUrl(config, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.description || `Telegram API ${method} 调用失败`);
  }
  return result.result;
}

async function sendMessage(config, chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };
  if (keyboard) {
    body.reply_markup = { inline_keyboard: keyboard };
  }
  return telegramCall(config, 'sendMessage', body);
}

async function editMessage(config, chatId, messageId, text, keyboard) {
  if (messageId == null) return sendMessage(config, chatId, text, keyboard);
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true
  };
  if (keyboard) {
    body.reply_markup = { inline_keyboard: keyboard };
  }
  try {
    return await telegramCall(config, 'editMessageText', body);
  } catch (error) {
    // Telegram 在内容完全相同时会返回 MESSAGE_NOT_MODIFIED。
    // 这种情况下无需再发送一条重复消息。
    if (String(error?.message || '').includes('message is not modified')) return null;
    throw error;
  }
}

async function answerCallback(config, callbackQueryId, text = '') {
  try {
    await telegramCall(config, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || undefined,
      show_alert: false
    });
  } catch (error) {
    console.error('[TG Bot] answerCallbackQuery 失败:', error);
  }
}

function buttons(rows) {
  return rows;
}

function mainMenu() {
  return buttons([
    [
      { text: '📋 我的订阅', callback_data: 'menu:list' },
      { text: '🔎 查询', callback_data: 'menu:query' },
      { text: '➕ 添加订阅', callback_data: 'menu:add' }
    ],
    [
      { text: '🔄 续订', callback_data: 'menu:renew' },
      { text: '🔔 即将到期', callback_data: 'menu:expiring' }
    ],
    [
      { text: '📜 支付记录', callback_data: 'menu:payments' },
      { text: '📊 统计', callback_data: 'menu:stats' }
    ],
    [
      { text: '❓ 帮助', callback_data: 'menu:help' }
    ]
  ]);
}

function subButtons(subscriptions, action = 'view') {
  return subscriptions.slice(0, 30).map((s) => [{
    text: `${s.isActive ? '🟢' : '⏸️'} ${truncate(s.name, 42)}`,
    callback_data: `${action}:${s.id}`
  }]);
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function localDateString(date, timezone) {
  const p = getTimezoneDateParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function daysRemaining(expiryDate, timezone) {
  const today = localDateString(new Date(), timezone);
  const expiry = localDateString(new Date(expiryDate), timezone);
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${expiry}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function statusText(sub, timezone) {
  if (!sub.isActive) return '⏸️ 已停用';
  const days = daysRemaining(sub.expiryDate, timezone);
  if (days < 0) return `🔴 已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '🔴 今天到期';
  if (days <= 7) return `🟠 剩余 ${days} 天`;
  return `🟢 剩余 ${days} 天`;
}

function subscriptionText(sub, config) {
  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const amount = formatAmount(sub.amount, sub.currency || 'CNY');
  const expiry = formatTimeInTimezone(new Date(sub.expiryDate), timezone, 'date');
  const start = sub.startDate
    ? formatTimeInTimezone(new Date(sub.startDate), timezone, 'date')
    : '未设置';
  const cycle = `${sub.periodValue || 1}${unitText(sub.periodUnit)}`;
  return [
    `📦 ${sub.name}`,
    '',
    `${statusText(sub, timezone)}`,
    `📅 到期：${expiry}`,
    `🚀 开始：${start}`,
    `🔁 周期：${cycle}`,
    `💰 费用：${amount || '未设置'}${amount ? '/周期' : ''}`,
    `📂 分类：${sub.category || '未分类'}`,
    `♻️ 自动续期：${sub.autoRenew ? '是' : '否'}`,
    `📝 备注：${sub.notes || '无'}`
  ].join('\n');
}

function unitText(unit) {
  return unit === 'day' ? '天' : unit === 'week' ? '周' : unit === 'year' ? '年' : '月';
}

function sessionKey(chatId) {
  return `tg_session:${chatId}`;
}

async function getSession(env, chatId) {
  const raw = await env.SUBSCRIPTIONS_KV.get(sessionKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setSession(env, chatId, session) {
  await env.SUBSCRIPTIONS_KV.put(sessionKey(chatId), JSON.stringify(session), {
    expirationTtl: SESSION_TTL
  });
}

async function clearSession(env, chatId) {
  await env.SUBSCRIPTIONS_KV.delete(sessionKey(chatId));
}

function allowedChat(config, chatId) {
  const configured = String(config.TG_CHAT_ID || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return configured.includes(String(chatId));
}

function helpText() {
  return [
    '🤖 SubsTracker Telegram 助手',
    '',
    '常用命令：',
    '/start - 打开主菜单',
    '/list - 查看订阅',
    '/add - 添加订阅',
    '/renew - 续订',
    '/expiring - 查看即将到期',
    '/stats - 查看统计',
    '/cancel - 取消当前操作',
    '',
    '也可以直接使用下面的按钮操作。'
  ].join('\n');
}

async function showMain(config, chatId, greeting = true, messageId = null) {
  await editMessage(
    config,
    chatId,
    messageId,
    greeting
      ? '📦 SubsTracker\n\n欢迎使用订阅管理助手。请选择操作：'
      : '请选择操作：',
    mainMenu()
  );
}

async function showList(config, chatId, env, messageId = null) {
  const subs = await getAllSubscriptions(env);
  if (!subs.length) {
    await editMessage(config, chatId, messageId, '📋 当前没有订阅。', mainMenu());
    return;
  }
  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const sorted = [...subs].sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
  const lines = sorted.slice(0, 30).map((s) => {
    const expiry = formatTimeInTimezone(new Date(s.expiryDate), timezone, 'date');
    return `${s.isActive ? '🟢' : '⏸️'} ${s.name} · ${expiry} · ${statusText(s, timezone)}`;
  });
  await editMessage(
    config,
    chatId,
    messageId,
    `📋 我的订阅（共 ${subs.length} 个）\n\n${lines.join('\n')}`,
    subButtons(sorted, 'view')
  );
}

async function showExpiring(config, chatId, env, messageId = null) {
  const subs = await getAllSubscriptions(env);
  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const expiring = subs
    .filter((s) => s.isActive)
    .filter((s) => {
      const d = daysRemaining(s.expiryDate, timezone);
      return d >= 0 && d <= 30;
    })
    .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

  if (!expiring.length) {
    await editMessage(config, chatId, messageId, '🔔 未来 30 天没有即将到期的订阅。', mainMenu());
    return;
  }

  const text = [
    '🔔 即将到期',
    '',
    ...expiring.map((s) => {
      const d = daysRemaining(s.expiryDate, timezone);
      return `${d === 0 ? '🔴 今天' : `🟠 ${d} 天`} · ${s.name}`;
    })
  ].join('\n');

  await editMessage(config, chatId, messageId, text, subButtons(expiring, 'view'));
}

async function showStats(config, chatId, env, messageId = null) {
  const subs = await getAllSubscriptions(env);
  const active = subs.filter((s) => s.isActive);
  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const soon = active.filter((s) => {
    const d = daysRemaining(s.expiryDate, timezone);
    return d >= 0 && d <= 30;
  });
  const expired = active.filter((s) => daysRemaining(s.expiryDate, timezone) < 0);

  const currencyTotals = {};
  for (const sub of active) {
    const currency = sub.currency || 'CNY';
    currencyTotals[currency] = (currencyTotals[currency] || 0) + Number(sub.amount || 0);
  }

  const totalText = Object.entries(currencyTotals)
    .map(([currency, amount]) => `${formatAmount(amount, currency)}/周期`)
    .join('\n') || '暂无金额数据';

  await editMessage(config, chatId, messageId, [
    '📊 订阅统计',
    '',
    `全部订阅：${subs.length}`,
    `启用中：${active.length}`,
    `未来 30 天到期：${soon.length}`,
    `已过期：${expired.length}`,
    '',
    '当前周期费用：',
    totalText
  ].join('\n'), mainMenu());
}

async function showPayments(config, chatId, env, messageId = null) {
  const subs = await getAllSubscriptions(env);
  const withPayments = subs.filter((s) => Array.isArray(s.paymentHistory) && s.paymentHistory.length);
  if (!withPayments.length) {
    await editMessage(config, chatId, messageId, '📜 暂无支付记录。', mainMenu());
    return;
  }
  await editMessage(
    config,
    chatId,
    messageId,
    '📜 请选择要查看支付记录的订阅：',
    subButtons(withPayments, 'payments')
  );
}

async function showSubscription(config, chatId, env, id, messageId = null) {
  const sub = await getSubscription(id, env);
  if (!sub) {
    await editMessage(config, chatId, messageId, '❌ 订阅不存在，可能已经被删除。', mainMenu());
    return;
  }

  await editMessage(config, chatId, messageId, subscriptionText(sub, config), [
    [
      { text: '🔄 续订', callback_data: `renew:${sub.id}` },
      { text: sub.isActive ? '⏸️ 停用' : '▶️ 启用', callback_data: `toggle:${sub.id}` }
    ],
    [
      { text: '📜 支付记录', callback_data: `payments:${sub.id}` },
      { text: '🗑️ 删除', callback_data: `deleteask:${sub.id}` }
    ],
    [{ text: '🏠 主菜单', callback_data: 'menu:home' }]
  ]);
}

async function showPaymentHistory(config, chatId, env, id, messageId = null) {
  const sub = await getSubscription(id, env);
  if (!sub) {
    await editMessage(config, chatId, messageId, '❌ 订阅不存在。', mainMenu());
    return;
  }
  const history = [...(sub.paymentHistory || [])]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20);
  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const text = [
    `📜 ${sub.name} · 支付记录`,
    '',
    ...history.map((p) => {
      const date = formatTimeInTimezone(new Date(p.date), timezone, 'date');
      const amount = formatAmount(p.amount, p.currency || sub.currency || 'CNY') || '未记录金额';
      return `• ${date} · ${amount} · ${p.note || (p.type === 'initial' ? '初始订阅' : '续订')}`;
    })
  ].join('\n');

  await editMessage(config, chatId, messageId, text, [
    [{ text: '🔙 返回订阅', callback_data: `view:${sub.id}` }],
    [{ text: '🏠 主菜单', callback_data: 'menu:home' }]
  ]);
}

async function beginAdd(config, chatId, env, messageId = null) {
  await setSession(env, chatId, { action: 'add', step: 'name', data: {} });
  await editMessage(config, chatId, messageId, '➕ 添加订阅\n\n请输入订阅名称，例如：Netflix', [
    [{ text: '❌ 取消', callback_data: 'cancel' }]
  ]);
}

async function handleAddMessage(config, chatId, env, session, text) {
  if (session.step === 'name') {
    if (!text || text.length > 100) {
      await sendMessage(config, chatId, '订阅名称不能为空，且不能超过 100 个字符，请重新输入。');
      return;
    }
    session.data.name = text;
    session.step = 'startDate';
    await setSession(env, chatId, session);
    await sendMessage(config, chatId, '请输入开始日期，格式：YYYY-MM-DD\n例如：2026-09-28');
    return;
  }

  if (session.step === 'startDate') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      await sendMessage(config, chatId, '日期格式不正确，请使用 YYYY-MM-DD。');
      return;
    }
    const date = parseDateInputInTimezone(text, config.TIMEZONE || 'Asia/Shanghai');
    if (Number.isNaN(date.getTime())) {
      await sendMessage(config, chatId, '日期无效，请重新输入。');
      return;
    }
    session.data.startDate = text;
    session.step = 'amount';
    await setSession(env, chatId, session);
    await sendMessage(config, chatId, '请输入每个周期的金额。\n例如：20 或 20 USD。\n如果不记录金额，请输入 0。');
    return;
  }

  if (session.step === 'amount') {
    const match = text.trim().match(/^([0-9]+(?:[.,][0-9]+)?)(?:\s+([A-Za-z]{3}))?$/);
    if (!match) {
      await sendMessage(config, chatId, '金额格式不正确，请输入例如 20、20 USD 或 0。');
      return;
    }
    const amount = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) {
      await sendMessage(config, chatId, '金额必须是大于等于 0 的数字。');
      return;
    }
    session.data.amount = amount;
    session.data.currency = (match[2] || 'CNY').toUpperCase();
    session.step = 'cycle';
    await setSession(env, chatId, session);
    await sendMessage(config, chatId, '请选择订阅周期：', [
      [
        { text: '1个月', callback_data: 'addcycle:month:1' },
        { text: '3个月', callback_data: 'addcycle:month:3' }
      ],
      [
        { text: '6个月', callback_data: 'addcycle:month:6' },
        { text: '1年', callback_data: 'addcycle:year:1' }
      ],
      [{ text: '🗓️ 自定义天数', callback_data: 'addcustom' }],
      [{ text: '❌ 取消', callback_data: 'cancel' }]
    ]);
    return;
  }

  if (session.step === 'customCycle') {
    const raw = text.trim();
    if (!/^\d+$/.test(raw)) {
      await sendMessage(config, chatId, '天数必须是 1～3650 之间的正整数，请重新输入。');
      return;
    }
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      await sendMessage(config, chatId, '天数必须是 1～3650 之间的正整数，请重新输入。');
      return;
    }
    session.data.periodValue = days;
    session.data.periodUnit = 'day';
    session.step = 'mode';
    await setSession(env, chatId, session);
    await sendMessage(config, chatId, '请选择订阅方式：', [
      [{ text: '📅 循环订阅', callback_data: 'addmode:cycle' }],
      [{ text: '⏳ 到期重置', callback_data: 'addmode:reset' }],
      [{ text: '❌ 取消', callback_data: 'cancel' }]
    ]);
  }
}

async function selectAddCycle(config, chatId, env, unit, value, messageId = null) {
  const session = await getSession(env, chatId);
  if (!session || session.action !== 'add') {
    await editMessage(config, chatId, messageId, '添加操作已过期，请重新点击「添加订阅」。', mainMenu());
    return;
  }
  session.data.periodValue = Number(value);
  session.data.periodUnit = unit;
  session.step = 'mode';
  await setSession(env, chatId, session);
  await editMessage(config, chatId, messageId, '请选择订阅方式：', [
    [{ text: '📅 循环订阅', callback_data: 'addmode:cycle' }],
    [{ text: '⏳ 到期重置', callback_data: 'addmode:reset' }],
    [{ text: '❌ 取消', callback_data: 'cancel' }]
  ]);
}

async function selectAddMode(config, chatId, env, mode, messageId = null) {
  const session = await getSession(env, chatId);
  if (!session || session.action !== 'add') {
    await editMessage(config, chatId, messageId, '添加操作已过期，请重新点击「添加订阅」。', mainMenu());
    return;
  }
  session.data.subscriptionMode = mode;
  session.step = 'expiryMode';
  await setSession(env, chatId, session);
  await editMessage(config, chatId, messageId, '请选择到期日期设置方式：', [
    [{ text: '🤖 自动计算到期日期', callback_data: 'addexpiry:auto' }],
    [{ text: '✏️ 手动输入到期日期', callback_data: 'addexpiry:manual' }],
    [{ text: '❌ 取消', callback_data: 'cancel' }]
  ]);
}

async function selectAddExpiryMode(config, chatId, env, mode, messageId = null) {
  const session = await getSession(env, chatId);
  if (!session || session.action !== 'add') {
    await editMessage(config, chatId, messageId, '添加操作已过期，请重新点击「添加订阅」。', mainMenu());
    return;
  }

  if (mode === 'manual') {
    session.step = 'expiryManual';
    await setSession(env, chatId, session);
    await editMessage(config, chatId, messageId, '✏️ 请输入到期日期，格式：YYYY-MM-DD\n例如：2026-12-31', [
      [{ text: '❌ 取消', callback_data: 'cancel' }]
    ]);
    return;
  }

  return completeAdd(config, chatId, env, messageId);
}

async function completeAdd(config, chatId, env, messageId = null) {
  const session = await getSession(env, chatId);
  if (!session || session.action !== 'add') {
    await editMessage(config, chatId, messageId, '添加操作已过期，请重新点击「添加订阅」。', mainMenu());
    return;
  }

  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const startDate = parseDateInputInTimezone(session.data.startDate, timezone);
  if (Number.isNaN(startDate.getTime())) {
    await editMessage(config, chatId, messageId, '❌ 开始日期无效。', mainMenu());
    return;
  }

  let expiryDate = session.data.expiryDate;
  if (!expiryDate) {
    const calculated = addCalendarPeriodInTimezone(
      startDate,
      Number(session.data.periodValue),
      session.data.periodUnit,
      timezone,
      { endOfMonth: false }
    );
    expiryDate = localDateString(calculated, timezone);
  }

  const amount = Number(session.data.amount);
  const result = await createSubscription({
    name: session.data.name,
    startDate: session.data.startDate,
    expiryDate,
    amount,
    currency: session.data.currency || 'CNY',
    periodValue: Number(session.data.periodValue),
    periodUnit: session.data.periodUnit,
    subscriptionMode: session.data.subscriptionMode || 'cycle',
    isActive: true,
    autoRenew: true,
    // Telegram 添加订阅时，用户明确给出的开始/到期日期必须原样保存，
    // 不要因为该日期早于今天而自动滚动到当前日期。
    preserveExplicitDates: true
  }, env);

  await clearSession(env, chatId);

  if (!result.success) {
    await editMessage(config, chatId, messageId, `❌ 添加失败：${result.message || '未知错误'}`, mainMenu());
    return;
  }

  await editMessage(config, chatId, messageId, `✅ 添加成功\n\n${subscriptionText(result.subscription, config)}`, [
    [{ text: '🔄 立即续订', callback_data: `renew:${result.subscription.id}` }],
    [{ text: '🏠 主菜单', callback_data: 'menu:home' }]
  ]);
}

async function beginRenew(config, chatId, env, id, messageId = null) {
  const sub = await getSubscription(id, env);
  if (!sub) {
    await editMessage(config, chatId, messageId, '❌ 订阅不存在。', mainMenu());
    return;
  }

  await setSession(env, chatId, {
    action: 'renew',
    step: 'select',
    data: { id }
  });

  const amount = Number(sub.amount || 0);
  await editMessage(config, chatId, messageId, [
    `🔄 续订：${sub.name}`,
    '',
    `当前费用：${formatAmount(amount, sub.currency || 'CNY') || '未设置'}/周期`,
    '请选择续订时长：'
  ].join('\n'), [
    [
      { text: '1周期', callback_data: `renewconfirm:${id}:1` },
      { text: '3周期', callback_data: `renewconfirm:${id}:3` }
    ],
    [
      { text: '6周期', callback_data: `renewconfirm:${id}:6` },
      { text: '12周期', callback_data: `renewconfirm:${id}:12` }
    ],
    [{ text: '❌ 取消', callback_data: 'cancel' }]
  ]);
}

async function completeRenew(config, chatId, env, id, multiplier, messageId = null) {
  const sub = await getSubscription(id, env);
  if (!sub) {
    await clearSession(env, chatId);
    await editMessage(config, chatId, messageId, '❌ 订阅不存在。', mainMenu());
    return;
  }

  const n = Math.max(1, Math.min(120, Number(multiplier) || 1));
  const amount = Number(sub.amount || 0) * n;
  const result = await manualRenewSubscription(id, env, {
    periodMultiplier: n,
    amount,
    note: `Telegram 续订 ${n} 周期`
  });

  await clearSession(env, chatId);

  if (!result.success) {
    await editMessage(config, chatId, messageId, `❌ 续订失败：${result.message || '未知错误'}`, mainMenu());
    return;
  }

  // 续订成功后不要把原通知里的其他快捷续订按钮一起替换掉。
  // 重新读取当前即将到期订阅，并重建快捷按钮，让同一条消息继续可操作。
  const timezone = config.TIMEZONE || 'Asia/Shanghai';
  const subscriptions = await getAllSubscriptions(env);
  const expiring = subscriptions
    .filter((s) => s.isActive)
    .filter((s) => {
      const days = daysRemaining(s.expiryDate, timezone);
      return days >= 0 && days <= 30;
    })
    .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())
    .slice(0, 20);

  const remainingKeyboard = expiring.map((s) => [{
    text: `🔄 ${truncate(s.name, 24)}`,
    callback_data: `quickrenew:${s.id}:1`
  }, {
    text: '3周期',
    callback_data: `quickrenew:${s.id}:3`
  }, {
    text: '6周期',
    callback_data: `quickrenew:${s.id}:6`
  }, {
    text: '12周期',
    callback_data: `quickrenew:${s.id}:12`
  }]);

  const keyboard = [
    [{ text: '📜 查看支付记录', callback_data: `payments:${id}` }]
  ];
  if (remainingKeyboard.length) keyboard.push(...remainingKeyboard);
  keyboard.push([{ text: '🏠 主菜单', callback_data: 'menu:home' }]);

  const suffix = remainingKeyboard.length
    ? `\n\n🔔 其他即将到期订阅仍可直接续订（共 ${remainingKeyboard.length} 个）：`
    : '\n\n🎉 当前没有其他未来 30 天内到期的订阅。';

  await editMessage(
    config,
    chatId,
    messageId,
    `✅ 续订成功\n\n${subscriptionText(result.subscription, config)}${suffix}`,
    keyboard
  );
}

async function deleteSubscriptionFromTelegram(config, chatId, env, id, messageId = null) {
  const sub = await getSubscription(id, env);
  if (!sub) {
    await editMessage(config, chatId, messageId, '❌ 订阅不存在。', mainMenu());
    return;
  }
  const result = await deleteSubscription(id, env);
  if (!result.success) {
    await editMessage(config, chatId, messageId, `❌ 删除失败：${result.message || '未知错误'}`, mainMenu());
    return;
  }
  await editMessage(config, chatId, messageId, `🗑️ 已删除「${sub.name}」。`, mainMenu());
}

async function toggleSubscriptionFromTelegram(config, chatId, env, id, messageId = null) {
  const sub = await getSubscription(id, env);
  if (!sub) {
    await editMessage(config, chatId, messageId, '❌ 订阅不存在。', mainMenu());
    return;
  }
  const result = await toggleSubscriptionStatus(id, !sub.isActive, env);
  if (!result.success) {
    await editMessage(config, chatId, messageId, `❌ 操作失败：${result.message || '未知错误'}`, mainMenu());
    return;
  }
  await editMessage(
    config,
    chatId,
    messageId,
    `${result.subscription.isActive ? '▶️ 已启用' : '⏸️ 已停用'}「${sub.name}」。`,
    [
      [{ text: '📦 查看订阅', callback_data: `view:${id}` }],
      [{ text: '🏠 主菜单', callback_data: 'menu:home' }]
    ]
  );
}

function secretMatches(request, config) {
  const configured = String(config.TG_WEBHOOK_SECRET || '').trim();
  if (!configured) return true;
  return request.headers.get('X-Telegram-Bot-Api-Secret-Token') === configured;
}

function webhookSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureWebhookSecret(env, config) {
  if (config.TG_WEBHOOK_SECRET) return config;
  const updated = { ...config, TG_WEBHOOK_SECRET: webhookSecret() };
  await setConfig(env, updated);
  return updated;
}

/**
 * 管理员调用：设置 Telegram Webhook。
 * POST /api/telegram/setup-webhook
 */
async function handleSetupWebhook(request, env) {
  try {
    const config = await getConfig(env);
    if (!config.TG_BOT_TOKEN) {
      return jsonResponse({ success: false, message: '请先配置 TG_BOT_TOKEN' }, 400);
    }
    if (!String(config.TG_CHAT_ID || '').trim()) {
      return jsonResponse({ success: false, message: '请先配置 TG Chat ID，用于授权 Telegram 交互账户' }, 400);
    }
    const updated = await ensureWebhookSecret(env, config);
    const url = new URL(request.url);
    const webhookUrl = `${url.origin}/telegram/webhook`;

    const result = await telegramCall(updated, 'setWebhook', {
      url: webhookUrl,
      secret_token: updated.TG_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false
    });

    return jsonResponse({
      success: true,
      webhookUrl,
      message: 'Telegram Webhook 设置成功',
      telegram: result
    });
  } catch (error) {
    console.error('[TG Bot] 设置 Webhook 失败:', error);
    return jsonResponse({ success: false, message: error.message || '设置 Webhook 失败' }, 400);
  }
}

async function handleTelegramWebhook(request, env) {
  const config = await getConfig(env);

  if (!config.TG_BOT_TOKEN) {
    return new Response('Telegram Bot 未配置', { status: 503 });
  }
  if (!secretMatches(request, config)) {
    return new Response('Forbidden', { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  try {
    const message = update?.message;
    const callback = update?.callback_query;
    const chat = message?.chat || callback?.message?.chat;
    const chatId = chat?.id;

    if (chatId == null || !allowedChat(config, chatId)) {
      if (chatId != null) {
        try {
          await sendMessage(config, chatId, '🔒 此 Telegram 账户未授权使用 SubsTracker。');
        } catch (error) {
          console.error('[TG Bot] 未授权消息发送失败:', error);
        }
      }
      return new Response('OK');
    }

    if (callback) {
      await answerCallback(config, callback.id);
      await handleCallback(config, chatId, env, callback.data || '', callback?.message?.message_id ?? null);
      return new Response('OK');
    }

    const text = String(message?.text || '').trim();
    if (!text) return new Response('OK');

    if (text === '/start' || text.startsWith('/start@')) {
      await clearSession(env, chatId);
      await showMain(config, chatId, true);
      return new Response('OK');
    }

    if (text === '/help' || text.startsWith('/help@')) {
      await sendMessage(config, chatId, helpText(), mainMenu());
      return new Response('OK');
    }

    if (text === '/cancel') {
      await clearSession(env, chatId);
      await sendMessage(config, chatId, '✅ 已取消当前操作。', mainMenu());
      return new Response('OK');
    }

    if (text === '/list') {
      await clearSession(env, chatId);
      await showList(config, chatId, env);
      return new Response('OK');
    }

    if (text === '/add') {
      await beginAdd(config, chatId, env);
      return new Response('OK');
    }

    if (text === '/renew') {
      await clearSession(env, chatId);
      const subs = await getAllSubscriptions(env);
      await sendMessage(config, chatId, '🔄 请选择要续订的订阅：', subButtons(subs.filter((s) => s.isActive), 'renew'));
      return new Response('OK');
    }

    if (text === '/expiring') {
      await clearSession(env, chatId);
      await showExpiring(config, chatId, env);
      return new Response('OK');
    }

    if (text === '/stats') {
      await clearSession(env, chatId);
      await showStats(config, chatId, env);
      return new Response('OK');
    }

    const session = await getSession(env, chatId);
    if (session?.action === 'add') {
      if (session.step === 'expiryManual') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          await sendMessage(config, chatId, '日期格式不正确，请使用 YYYY-MM-DD。');
          return new Response('OK');
        }
        const date = parseDateInputInTimezone(text, config.TIMEZONE || 'Asia/Shanghai');
        if (Number.isNaN(date.getTime())) {
          await sendMessage(config, chatId, '日期无效，请重新输入。');
          return new Response('OK');
        }
        session.data.expiryDate = text;
        await setSession(env, chatId, session);
        await completeAdd(config, chatId, env, null);
        return new Response('OK');
      }
      await handleAddMessage(config, chatId, env, session, text);
      return new Response('OK');
    }

    if (session?.action === 'query') {
      await clearSession(env, chatId);
      const keyword = text.trim();
      const subs = await getAllSubscriptions(env);
      const found = subs.filter((s) => String(s.name || '').toLowerCase().includes(keyword.toLowerCase()));
      if (!found.length) {
        await sendMessage(config, chatId, `🔎 没有找到「${keyword}」。`, mainMenu());
      } else {
        await sendMessage(config, chatId, `🔎 找到 ${found.length} 个订阅：`, subButtons(found, 'view'));
      }
      return new Response('OK');
    }

    // 简单查询：发送“查询 xxx”或“/query xxx”
    const query = text.startsWith('/query ')
      ? text.slice(7).trim()
      : text.startsWith('查询 ')
        ? text.slice(3).trim()
        : '';
    if (query) {
      const subs = await getAllSubscriptions(env);
      const found = subs.filter((s) => String(s.name).toLowerCase().includes(query.toLowerCase()));
      if (!found.length) {
        await sendMessage(config, chatId, `🔎 没有找到「${query}」。`, mainMenu());
      } else {
        await sendMessage(config, chatId, `🔎 找到 ${found.length} 个订阅：`, subButtons(found, 'view'));
      }
      return new Response('OK');
    }

    await sendMessage(config, chatId, '我没有理解这条指令，请使用 /start 打开菜单。', mainMenu());
    return new Response('OK');
  } catch (error) {
    console.error('[TG Bot] 处理更新失败:', error);
    try {
      const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
      if (chatId != null) await sendMessage(config, chatId, `❌ 操作失败：${error.message || '服务器错误'}`, mainMenu());
    } catch (sendError) {
      console.error('[TG Bot] 错误提示发送失败:', sendError);
    }
    return new Response('OK');
  }
}

async function handleCallback(config, chatId, env, data, messageId = null) {
  if (data === 'cancel') {
    await clearSession(env, chatId);
    return editMessage(config, chatId, messageId, '✅ 已取消当前操作。', mainMenu());
  }

  if (data === 'menu:home') {
    await clearSession(env, chatId);
    return showMain(config, chatId, false, messageId);
  }
  if (data === 'menu:list') return showList(config, chatId, env, messageId);
  if (data === 'menu:query') {
    await setSession(env, chatId, { action: 'query', step: 'keyword', data: {} });
    return editMessage(config, chatId, messageId, '🔎 请输入要查询的订阅名称或关键词：', [
      [{ text: '❌ 取消', callback_data: 'cancel' }]
    ]);
  }
  if (data === 'menu:add') return beginAdd(config, chatId, env, messageId);
  if (data === 'menu:renew') {
    const subs = await getAllSubscriptions(env);
    return editMessage(config, chatId, messageId, '🔄 请选择要续订的订阅：', subButtons(subs.filter((s) => s.isActive), 'renew'));
  }
  if (data === 'menu:expiring') return showExpiring(config, chatId, env, messageId);
  if (data === 'menu:stats') return showStats(config, chatId, env, messageId);
  if (data === 'menu:payments') return showPayments(config, chatId, env, messageId);
  if (data === 'menu:help') return editMessage(config, chatId, messageId, helpText(), mainMenu());

  if (data === 'addcustom') {
    const session = await getSession(env, chatId);
    if (!session || session.action !== 'add') {
      return editMessage(config, chatId, messageId, '添加操作已过期，请重新点击「添加订阅」。', mainMenu());
    }
    session.step = 'customCycle';
    await setSession(env, chatId, session);
    return editMessage(config, chatId, messageId, '🗓️ 自定义订阅周期\n\n请输入周期天数，例如：5、30、365\n请输入 1～3650 之间的正整数。', [
      [{ text: '❌ 取消', callback_data: 'cancel' }]
    ]);
  }
  if (data.startsWith('addcycle:')) {
    const [, unit, value] = data.split(':');
    return selectAddCycle(config, chatId, env, unit, Number(value), messageId);
  }
  if (data.startsWith('addmode:')) {
    return selectAddMode(config, chatId, env, data.slice(8), messageId);
  }
  if (data.startsWith('addexpiry:')) {
    return selectAddExpiryMode(config, chatId, env, data.slice(10), messageId);
  }
  if (data.startsWith('view:')) return showSubscription(config, chatId, env, data.slice(5), messageId);
  if (data.startsWith('payments:')) return showPaymentHistory(config, chatId, env, data.slice(9), messageId);
  if (data.startsWith('renew:')) return beginRenew(config, chatId, env, data.slice(6), messageId);
  if (data.startsWith('quickrenew:')) {
    const [, id, multiplier] = data.split(':');
    return completeRenew(config, chatId, env, id, Number(multiplier), messageId);
  }
  if (data.startsWith('renewconfirm:')) {
    const [, id, multiplier] = data.split(':');
    return completeRenew(config, chatId, env, id, Number(multiplier), messageId);
  }
  if (data.startsWith('toggle:')) return toggleSubscriptionFromTelegram(config, chatId, env, data.slice(7), messageId);
  if (data.startsWith('deleteask:')) {
    const id = data.slice(10);
    const sub = await getSubscription(id, env);
    if (!sub) return editMessage(config, chatId, messageId, '❌ 订阅不存在。', mainMenu());
    return editMessage(config, chatId, messageId, `⚠️ 确定删除「${sub.name}」吗？\n\n删除后订阅及其支付记录会一起移除。`, [
      [
        { text: '🗑️ 确认删除', callback_data: `delete:${id}` },
        { text: '❌ 取消', callback_data: `view:${id}` }
      ]
    ]);
  }
  if (data.startsWith('delete:')) return deleteSubscriptionFromTelegram(config, chatId, env, data.slice(7), messageId);
}

export {
  handleTelegramWebhook,
  handleSetupWebhook
};
