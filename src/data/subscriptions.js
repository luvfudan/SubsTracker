// 注：本文件暂不启用 // @ts-check，因 lunar 库返回类型分支较多，类型清理推迟到后续 Task。
/**
 * 订阅业务层
 *
 * 本文件负责"订阅生命周期"相关的业务规则（创建时自动推算到期日、续订生成支付记录、
 * 删除支付记录回退周期、农历周期推算、初始支付记录等）。
 *
 * 重构：
 * - 数据存储从单 Key 数组改为 sub:{id} 多 Key（见 subscriptions.repo.js）
 * - 单条读写通过 repo.getById / repo.save，不再加载整个数组，降低并发风险
 * - 业务逻辑保持兼容，外部 API 签名不变
 *
 * 注意：reminderUnit/reminderValue 字段保留兼容，Task 8 会在新 API 引入
 * 多提醒规则（reminder_rules:{id}），届时 Service 层会同步两边。
 */

import { getConfig } from './config.js';
import {
  addCalendarPeriodInTimezone,
  getNowInTimezone,
  getTimezoneDateParts,
  getTimezoneMidnightTimestamp,
  parseDateInputInTimezone
} from '../core/time.js';
import { lunarCalendar, lunarBiz } from '../core/lunar.js';
import { resolveReminderSetting } from '../services/notify/reminder.js';
import * as subRepo from './subscriptions.repo.js';
import { addCategory } from './categories.js';

/**
 * 裁剪支付历史，保留 1 条 initial + 最近 N 条其他记录。
 *
 * @param {Array} records
 * @param {number} limit
 * @returns {Array}
 */
function trimPaymentHistory(records = [], limit = 100) {
  const safeLimit = Math.min(1000, Math.max(10, Number(limit) || 100));
  if (!Array.isArray(records)) return [];
  if (records.length <= safeLimit) return records;

  const initialRecords = records.filter((item) => item && item.type === 'initial');
  const otherRecords = records.filter((item) => item && item.type !== 'initial');
  const keptOther = otherRecords.slice(-(safeLimit - Math.min(initialRecords.length, 1)));
  const keptInitial = initialRecords.length > 0 ? [initialRecords[0]] : [];
  return [...keptInitial, ...keptOther];
}

/**
 * @param {string | Date | number | null | undefined} value
 * @param {string} timezone
 * @returns {Date | null}
 */
function parseOptionalDateInTimezone(value, timezone) {
  if (value == null || value === '') return null;
  const parsed = parseDateInputInTimezone(value, timezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {string} timezone
 * @returns {Date}
 */
function buildTimezoneDate(year, month, day, timezone) {
  return parseDateInputInTimezone(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    timezone
  );
}

/**
 * 获取所有订阅（从新 repo 读取）。
 * 会附带 reminderRules / reminderRulesSummary，供列表展示真实提醒策略。
 *
 * @param {any} env
 * @returns {Promise<Array<any>>}
 */
async function getAllSubscriptions(env) {
  try {
    const { listForSubscription, formatRulesSummary, legacyFieldToRule } = await import('./reminders.repo.js');
    const subs = await subRepo.listAll(env);
    return Promise.all(
      subs.map(async (sub) => {
        let rules = await listForSubscription(env, sub.id);
        if (rules.length === 0) {
          rules = [legacyFieldToRule(sub)];
        }
        return {
          ...sub,
          reminderRules: rules,
          reminderRulesSummary: formatRulesSummary(rules)
        };
      })
    );
  } catch (error) {
    console.error('[subscriptions] 读取列表失败:', error);
    return [];
  }
}

/**
 * 将多规则同步回订阅上的 legacy 提醒字段，避免列表/旧路径与规则脱节。
 *
 * @param {any} env
 * @param {string} subId
 * @param {Array<any>} rules
 */
async function syncLegacyReminderFields(env, subId, rules) {
  try {
    const { deriveLegacyFromRules } = await import('./reminders.repo.js');
    const existing = await subRepo.getById(env, subId);
    if (!existing) return;
    const legacy = deriveLegacyFromRules(rules);
    await subRepo.save(env, {
      ...existing,
      reminderUnit: legacy.unit,
      reminderValue: legacy.value,
      reminderDays: legacy.unit === 'day' ? legacy.value : undefined,
      reminderHours: legacy.unit === 'hour' ? legacy.value : undefined,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[subscriptions] 同步 legacy 提醒字段失败:', error);
  }
}

/**
 * 按 ID 获取单条订阅。
 *
 * @param {string} id
 * @param {any} env
 */
async function getSubscription(id, env) {
  return subRepo.getById(env, id);
}

/**
 * 创建订阅。
 *
 * @param {any} subscription 来自前端的字段集
 * @param {any} env
 * @returns {Promise<{success: boolean, message?: string, subscription?: any}>}
 */
async function createSubscription(subscription, env) {
  try {
    if (!subscription.name || !subscription.expiryDate) {
      return { success: false, message: '缺少必填字段' };
    }

    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'Asia/Shanghai';
    const now = getNowInTimezone(timezone);
    const todayMidnight = getTimezoneMidnightTimestamp(now.utc, timezone);
    const startDate = parseOptionalDateInTimezone(subscription.startDate, timezone);
    let expiryDate = parseOptionalDateInTimezone(subscription.expiryDate, timezone);
    if (!expiryDate) {
      return { success: false, message: '到期日期格式无效' };
    }

    let useLunar = !!subscription.useLunar;
    if (useLunar) {
      const expiryParts = getTimezoneDateParts(expiryDate, timezone);
      let lunar = lunarCalendar.solar2lunar(
        expiryParts.year,
        expiryParts.month,
        expiryParts.day
      );

      if (lunar && subscription.periodValue && subscription.periodUnit) {
        while (getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight) {
          lunar = lunarBiz.addLunarPeriod(lunar, subscription.periodValue, subscription.periodUnit);
          const solar = lunarBiz.lunar2solar(lunar);
          expiryDate = buildTimezoneDate(solar.year, solar.month, solar.day, timezone);
        }
      }
    } else {
      if (getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight && subscription.periodValue && subscription.periodUnit) {
        while (getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight) {
          const endOfMonth = !!subscription.endOfMonth && !useLunar;
          expiryDate = addCalendarPeriodInTimezone(
            expiryDate,
            subscription.periodValue,
            subscription.periodUnit,
            timezone,
            { endOfMonth }
          );
        }
      }
    }

    const reminderSetting = resolveReminderSetting(subscription);
    const normalizedStartDate = startDate ? startDate.toISOString() : null;
    const normalizedExpiryDate = expiryDate.toISOString();
    const endOfMonthFlag = !!subscription.endOfMonth && !useLunar;

    const initialPaymentDate = normalizedStartDate || now.utc.toISOString();
    const newSubscription = {
      id: Date.now().toString(),
      name: subscription.name,
      subscriptionMode: subscription.subscriptionMode || 'cycle',
      customType: subscription.customType || '',
      category: subscription.category ? subscription.category.trim() : '',
      startDate: normalizedStartDate,
      expiryDate: normalizedExpiryDate,
      periodValue: subscription.periodValue || 1,
      periodUnit: subscription.periodUnit || 'month',
      endOfMonth: endOfMonthFlag,
      reminderUnit: reminderSetting.unit,
      reminderValue: reminderSetting.value,
      reminderDays: reminderSetting.unit === 'day' ? reminderSetting.value : undefined,
      reminderHours: reminderSetting.unit === 'hour' ? reminderSetting.value : undefined,
      notes: subscription.notes || '',
      amount:
        subscription.amount !== undefined && subscription.amount !== null
          ? subscription.amount
          : null,
      currency: subscription.currency || 'CNY',
      lastPaymentDate: initialPaymentDate,
      paymentHistory:
        subscription.amount !== undefined && subscription.amount !== null
          ? [
              {
                id: Date.now().toString(),
                date: initialPaymentDate,
                amount: subscription.amount,
                currency: subscription.currency || 'CNY',
                type: 'initial',
                note: '初始订阅',
                periodStart: normalizedStartDate || initialPaymentDate,
                periodEnd: normalizedExpiryDate
              }
            ]
          : [],
      isActive: subscription.isActive !== false,
      autoRenew: subscription.autoRenew !== false,
      useLunar: useLunar,
      createdAt: new Date().toISOString()
    };

    await subRepo.save(env, newSubscription);
    if (newSubscription.category) await addCategory(env, newSubscription.category);

    return { success: true, subscription: newSubscription };
  } catch (error) {
    console.error('创建订阅异常：', error && error.stack ? error.stack : error);
    return { success: false, message: error && error.message ? error.message : '创建订阅失败' };
  }
}

/**
 * 更新订阅。
 *
 * @param {string} id
 * @param {any} subscription
 * @param {any} env
 */
async function updateSubscription(id, subscription, env) {
  try {
    const existing = await subRepo.getById(env, id);
    if (!existing) {
      return { success: false, message: '订阅不存在' };
    }

    if (!subscription.name || !subscription.expiryDate) {
      return { success: false, message: '缺少必填字段' };
    }

    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'Asia/Shanghai';
    const now = getNowInTimezone(timezone);
    const todayMidnight = getTimezoneMidnightTimestamp(now.utc, timezone);
    const incomingStartDate = parseOptionalDateInTimezone(subscription.startDate, timezone);
    let expiryDate = parseOptionalDateInTimezone(subscription.expiryDate, timezone);
    if (!expiryDate) {
      return { success: false, message: '到期日期格式无效' };
    }

    let useLunar = !!subscription.useLunar;
    if (useLunar) {
      const expiryParts = getTimezoneDateParts(expiryDate, timezone);
      let lunar = lunarCalendar.solar2lunar(
        expiryParts.year,
        expiryParts.month,
        expiryParts.day
      );
      if (!lunar) {
        return { success: false, message: '农历日期超出支持范围（1900-2100年）' };
      }
      if (lunar && getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight && subscription.periodValue && subscription.periodUnit) {
        do {
          lunar = lunarBiz.addLunarPeriod(lunar, subscription.periodValue, subscription.periodUnit);
          const solar = lunarBiz.lunar2solar(lunar);
          expiryDate = buildTimezoneDate(solar.year, solar.month, solar.day, timezone);
        } while (getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight);
      }
    } else {
      const endOfMonth =
        subscription.endOfMonth !== undefined
          ? !!subscription.endOfMonth && !useLunar
          : !!existing.endOfMonth && !useLunar;
      if (getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight && subscription.periodValue && subscription.periodUnit) {
        while (getTimezoneMidnightTimestamp(expiryDate, timezone) < todayMidnight) {
          expiryDate = addCalendarPeriodInTimezone(
            expiryDate,
            subscription.periodValue,
            subscription.periodUnit,
            timezone,
            { endOfMonth }
          );
        }
      }
    }

    const reminderSource = {
      reminderUnit:
        subscription.reminderUnit !== undefined ? subscription.reminderUnit : existing.reminderUnit,
      reminderValue:
        subscription.reminderValue !== undefined ? subscription.reminderValue : existing.reminderValue,
      reminderHours:
        subscription.reminderHours !== undefined ? subscription.reminderHours : existing.reminderHours,
      reminderDays:
        subscription.reminderDays !== undefined ? subscription.reminderDays : existing.reminderDays
    };
    const reminderSetting = resolveReminderSetting(reminderSource);

    const newAmount = subscription.amount !== undefined ? subscription.amount : existing.amount;
    let paymentHistory = existing.paymentHistory || [];

    const hasInitialPayment = paymentHistory.some((p) => p.type === 'initial');
    const amountChanged = newAmount !== existing.amount ||
      (subscription.currency !== undefined && subscription.currency !== existing.currency);

    if (amountChanged && hasInitialPayment) {
      const idx = paymentHistory.findIndex((p) => p.type === 'initial');
      paymentHistory[idx] = {
        ...paymentHistory[idx],
        amount: newAmount,
        currency: subscription.currency || existing.currency || 'CNY'
      };
    } else if (!hasInitialPayment && newAmount !== null && newAmount !== undefined && newAmount > 0) {
      const initialDate = existing.startDate || existing.createdAt || new Date().toISOString();
      paymentHistory.unshift({
        id: Date.now().toString(),
        date: initialDate,
        amount: newAmount,
        currency: subscription.currency || existing.currency || 'CNY',
        type: 'initial',
        note: '初始订阅',
        periodStart: existing.startDate || initialDate,
        periodEnd: existing.expiryDate || initialDate
      });
    }

    const merged = {
      ...existing,
      name: subscription.name,
      subscriptionMode: subscription.subscriptionMode || existing.subscriptionMode || 'cycle',
      customType: subscription.customType || existing.customType || '',
      category:
        subscription.category !== undefined
          ? subscription.category.trim()
          : existing.category || '',
      startDate:
        subscription.startDate !== undefined
          ? incomingStartDate
            ? incomingStartDate.toISOString()
            : existing.startDate
          : existing.startDate,
      expiryDate: expiryDate.toISOString(),
      periodValue: subscription.periodValue || existing.periodValue || 1,
      periodUnit: subscription.periodUnit || existing.periodUnit || 'month',
      endOfMonth:
        subscription.endOfMonth !== undefined
          ? !!subscription.endOfMonth && !useLunar
          : !!existing.endOfMonth && !useLunar,
      reminderUnit: reminderSetting.unit,
      reminderValue: reminderSetting.value,
      reminderDays: reminderSetting.unit === 'day' ? reminderSetting.value : undefined,
      reminderHours: reminderSetting.unit === 'hour' ? reminderSetting.value : undefined,
      notes: subscription.notes || '',
      amount: newAmount,
      currency: subscription.currency || existing.currency || 'CNY',
      lastPaymentDate:
        existing.lastPaymentDate ||
        existing.startDate ||
        existing.createdAt ||
        now.utc.toISOString(),
      paymentHistory,
      isActive: subscription.isActive !== undefined ? subscription.isActive : existing.isActive,
      autoRenew:
        subscription.autoRenew !== undefined
          ? subscription.autoRenew
          : existing.autoRenew !== undefined
            ? existing.autoRenew
            : true,
      useLunar: useLunar,
      updatedAt: new Date().toISOString()
    };

    await subRepo.save(env, merged);
    if (merged.category) await addCategory(env, merged.category);

    return { success: true, subscription: merged };
  } catch (error) {
    console.error('[subscriptions] 更新订阅失败:', error);
    return { success: false, message: '更新订阅失败' };
  }
}

/**
 * 删除订阅。
 *
 * @param {string} id
 * @param {any} env
 */
async function deleteSubscription(id, env) {
  try {
    const ok = await subRepo.deleteById(env, id);
    if (!ok) return { success: false, message: '订阅不存在' };
    // 联动清理提醒规则，避免孤儿 reminder_rules:{id}
    try {
      const remindersRepo = await import('./reminders.repo.js');
      await remindersRepo.clearForSubscription(env, id);
    } catch (err) {
      console.error('[subscriptions] 清理提醒规则失败（订阅已删除）:', err);
    }
    return { success: true };
  } catch (error) {
    console.error('[subscriptions] 删除订阅失败:', error);
    return { success: false, message: '删除订阅失败' };
  }
}

/**
 * 手动续订订阅。
 *
 * 业务规则：
 * - reset 模式：以支付日期为新开始
 * - cycle 模式：现到期日 > 支付日 时接续，否则以支付日为新开始
 * - 农历模式按农历周期推算
 *
 * @param {string} id
 * @param {any} env
 * @param {{ paymentDate?: string|Date, amount?: number, periodMultiplier?: number, periodValue?: number, periodUnit?: string, note?: string }} options
 */
async function manualRenewSubscription(id, env, options = {}) {
  try {
    const subscription = await subRepo.getById(env, id);
    if (!subscription) return { success: false, message: '订阅不存在' };

    if (!subscription.periodValue || !subscription.periodUnit) {
      return { success: false, message: '订阅未设置续订周期' };
    }

    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'Asia/Shanghai';
    const now = getNowInTimezone(timezone);

    const paymentDate = options.paymentDate
      ? parseDateInputInTimezone(options.paymentDate, timezone)
      : now.utc;
    const amount = options.amount !== undefined ? options.amount : subscription.amount || 0;
    const periodMultiplier = options.periodMultiplier || 1;
    const renewalPeriodValue = options.periodValue || subscription.periodValue;
    const renewalPeriodUnit = options.periodUnit || subscription.periodUnit;
    const note = options.note || '手动续订';
    const mode = subscription.subscriptionMode || 'cycle';

    let newStartDate;
    const currentExpiryDate = new Date(subscription.expiryDate);

    if (mode === 'reset') {
      // 到期重置：从本次支付日期重新起算。
      newStartDate = new Date(paymentDate);
    } else {
      // 循环订阅：始终从原来的到期日继续累加周期。
      // 即使订阅已经过期，也不能把起点改成当前日期，否则会把历史到期日
      // 直接跳到今天，导致续订后的日期整体向后偏移。
      newStartDate = Number.isNaN(currentExpiryDate.getTime())
        ? new Date(paymentDate)
        : new Date(currentExpiryDate);
    }

    let newExpiryDate;
    if (subscription.useLunar) {
      const solarStart = getTimezoneDateParts(newStartDate, timezone);
      let lunar = lunarCalendar.solar2lunar(solarStart.year, solarStart.month, solarStart.day);
      let nextLunar = lunar;
      for (let i = 0; i < periodMultiplier; i++) {
        nextLunar = lunarBiz.addLunarPeriod(nextLunar, renewalPeriodValue, renewalPeriodUnit);
      }
      const solar = lunarBiz.lunar2solar(nextLunar);
      newExpiryDate = buildTimezoneDate(solar.year, solar.month, solar.day, timezone);
    } else {
      const totalPeriodValue = renewalPeriodValue * periodMultiplier;
      newExpiryDate = addCalendarPeriodInTimezone(
        newStartDate,
        totalPeriodValue,
        renewalPeriodUnit,
        timezone,
        { endOfMonth: !!subscription.endOfMonth }
      );
    }

    const paymentRecord = {
      id: Date.now().toString(),
      date: paymentDate.toISOString(),
      amount,
      currency: subscription.currency || 'CNY',
      type: 'manual',
      note,
      periodStart: newStartDate.toISOString(),
      periodEnd: newExpiryDate.toISOString()
    };

    const paymentHistoryLimit = config.PAYMENT_HISTORY_LIMIT || 100;
    const paymentHistory = [...(subscription.paymentHistory || []), paymentRecord];
    const trimmedPaymentHistory = trimPaymentHistory(paymentHistory, paymentHistoryLimit);

    const updated = {
      ...subscription,
      startDate: newStartDate.toISOString(),
      expiryDate: newExpiryDate.toISOString(),
      lastPaymentDate: paymentDate.toISOString(),
      paymentHistory: trimmedPaymentHistory
    };

    await subRepo.save(env, updated);

    return { success: true, subscription: updated, message: '续订成功' };
  } catch (error) {
    console.error('手动续订失败:', error);
    return { success: false, message: '续订失败: ' + (error && error.message ? error.message : error) };
  }
}

/**
 * 删除一条支付记录（删除时回退到期日）。
 *
 * @param {string} subscriptionId
 * @param {string} paymentId
 * @param {any} env
 */
async function deletePaymentRecord(subscriptionId, paymentId, env) {
  try {
    const subscription = await subRepo.getById(env, subscriptionId);
    if (!subscription) return { success: false, message: '订阅不存在' };

    const paymentHistory = subscription.paymentHistory || [];
    const paymentIndex = paymentHistory.findIndex((p) => p.id === paymentId);
    if (paymentIndex === -1) return { success: false, message: '支付记录不存在' };

    const deletedPayment = paymentHistory[paymentIndex];
    paymentHistory.splice(paymentIndex, 1);

    let newExpiryDate = subscription.expiryDate;
    let newLastPaymentDate = subscription.lastPaymentDate;

    if (paymentHistory.length > 0) {
      const sortedByPeriodEnd = [...paymentHistory].sort((a, b) => {
        const dateA = a.periodEnd ? new Date(a.periodEnd) : new Date(0);
        const dateB = b.periodEnd ? new Date(b.periodEnd) : new Date(0);
        return Number(dateB) - Number(dateA);
      });

      if (sortedByPeriodEnd[0].periodEnd) {
        newExpiryDate = sortedByPeriodEnd[0].periodEnd;
      }

      const sortedByDate = [...paymentHistory].sort(
        (a, b) => Number(new Date(b.date)) - Number(new Date(a.date))
      );
      newLastPaymentDate = sortedByDate[0].date;
    } else {
      if (deletedPayment.periodStart) newExpiryDate = deletedPayment.periodStart;
      newLastPaymentDate =
        subscription.startDate || subscription.createdAt || subscription.expiryDate;
    }

    const updated = {
      ...subscription,
      expiryDate: newExpiryDate,
      paymentHistory,
      lastPaymentDate: newLastPaymentDate
    };

    await subRepo.save(env, updated);

    return { success: true, subscription: updated, message: '支付记录已删除' };
  } catch (error) {
    console.error('删除支付记录失败:', error);
    return {
      success: false,
      message: '删除失败: ' + (error && error.message ? error.message : error)
    };
  }
}

/**
 * 更新支付记录。
 *
 * @param {string} subscriptionId
 * @param {string} paymentId
 * @param {{ date?: string, amount?: number, currency?: string, note?: string }} paymentData
 * @param {any} env
 */
async function updatePaymentRecord(subscriptionId, paymentId, paymentData, env) {
  try {
    const subscription = await subRepo.getById(env, subscriptionId);
    if (!subscription) return { success: false, message: '订阅不存在' };
    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'Asia/Shanghai';

    const paymentHistory = subscription.paymentHistory || [];
    const paymentIndex = paymentHistory.findIndex((p) => p.id === paymentId);
    if (paymentIndex === -1) return { success: false, message: '支付记录不存在' };

    const normalizedPaymentDate = parseOptionalDateInTimezone(paymentData.date, timezone);

    paymentHistory[paymentIndex] = {
      ...paymentHistory[paymentIndex],
      date: normalizedPaymentDate ? normalizedPaymentDate.toISOString() : paymentHistory[paymentIndex].date,
      amount:
        paymentData.amount !== undefined ? paymentData.amount : paymentHistory[paymentIndex].amount,
      currency:
        paymentData.currency ||
        paymentHistory[paymentIndex].currency ||
        subscription.currency ||
        'CNY',
      note: paymentData.note !== undefined ? paymentData.note : paymentHistory[paymentIndex].note
    };

    const sortedPayments = [...paymentHistory].sort(
      (a, b) => Number(new Date(b.date)) - Number(new Date(a.date))
    );
    const newLastPaymentDate = sortedPayments[0].date;

    const updated = {
      ...subscription,
      paymentHistory,
      lastPaymentDate: newLastPaymentDate
    };

    await subRepo.save(env, updated);

    return { success: true, subscription: updated, message: '支付记录已更新' };
  } catch (error) {
    console.error('更新支付记录失败:', error);
    return {
      success: false,
      message: '更新失败: ' + (error && error.message ? error.message : error)
    };
  }
}

/**
 * 启用/停用订阅。
 *
 * @param {string} id
 * @param {boolean} isActive
 * @param {any} env
 */
async function toggleSubscriptionStatus(id, isActive, env) {
  try {
    const existing = await subRepo.getById(env, id);
    if (!existing) return { success: false, message: '订阅不存在' };

    const updated = {
      ...existing,
      isActive: !!isActive,
      updatedAt: new Date().toISOString()
    };
    await subRepo.save(env, updated);

    return { success: true, subscription: updated };
  } catch (error) {
    console.error('[subscriptions] 切换状态失败:', error);
    return { success: false, message: '更新订阅状态失败' };
  }
}

export {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  manualRenewSubscription,
  deletePaymentRecord,
  updatePaymentRecord,
  toggleSubscriptionStatus,
  syncLegacyReminderFields
};
