import { getConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import { telegramChannel } from '../../services/notify/telegram.js';
import { getAllSubscriptions } from '../../data/subscriptions.js';
import { formatNotificationContent } from '../../services/notify/reminder.js';
import { getDaysBetween } from '../../core/time.js';


async function handleTestExpiringTelegram(request, env) {
  if (request.method !== 'POST') return null;

  try {
    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'UTC';
    const subscriptions = await getAllSubscriptions(env);

    const expiring = subscriptions
      .filter((sub) => sub.isActive)
      .map((sub) => ({
        ...sub,
        daysRemaining: getDaysBetween(new Date(), new Date(sub.expiryDate), timezone)
      }))
      .filter((sub) => sub.daysRemaining >= 0 && sub.daysRemaining <= 30)
      .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

    if (expiring.length === 0) {
      return new Response(
        JSON.stringify({ success: false, message: '当前没有未来 30 天内到期的启用订阅' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const title = '订阅到期/续费提醒（手动测试）';
    const content = formatNotificationContent(expiring, config);
    const result = await telegramChannel.send({
      title,
      content,
      metadata: {
        tags: expiring.map((s) => s.name),
        quickRenewIds: expiring.map((s) => ({ id: s.id, name: s.name }))
      }
    }, config);

    if (!result.success) {
      return new Response(
        JSON.stringify({ success: false, message: result.error || 'Telegram 推送失败' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `已手动推送 ${expiring.length} 个即将到期订阅到 Telegram`,
        count: expiring.length
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[手动测试] Telegram 即将到期推送失败:', error);
    return new Response(
      JSON.stringify({ success: false, message: '发送失败: ' + (error?.message || String(error)) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function handleThirdPartyNotify(request, env, config, url) {
  const path = url.pathname.slice(4);
  if (!path.startsWith('/notify/')) return null;

  const pathSegments = path.split('/');
  const tokenFromPath = pathSegments[2] || '';
  const tokenFromHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const tokenFromQuery = url.searchParams.get('token') || '';
  const providedToken = tokenFromPath || tokenFromHeader || tokenFromQuery;
  const expectedToken = config.THIRD_PARTY_API_TOKEN || '';

  if (!expectedToken) {
    return new Response(
      JSON.stringify({ message: '第三方 API 已禁用，请在后台配置访问令牌后使用' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!providedToken || providedToken !== expectedToken) {
    return new Response(
      JSON.stringify({ message: '访问未授权，令牌无效或缺失' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (request.method !== 'POST') return null;

  try {
    const body = await request.json();
    const title = body.title || '第三方通知';
    const content = body.content || '';

    if (!content) {
      return new Response(
        JSON.stringify({ message: '缺少必填参数 content' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const config = await getConfig(env);
    const bodyTagsRaw = Array.isArray(body.tags)
      ? body.tags
      : (typeof body.tags === 'string' ? body.tags.split(/[,，\s]+/) : []);
    const bodyTags = Array.isArray(bodyTagsRaw)
      ? bodyTagsRaw.filter(tag => typeof tag === 'string' && tag.trim().length > 0).map(tag => tag.trim())
      : [];

    await sendNotificationToAllChannels(title, content, config, '[第三方API]', {
      metadata: { tags: bodyTags }
    });

    return new Response(
      JSON.stringify({
        message: '发送成功',
        response: {
          errcode: 0,
          errmsg: 'ok',
          msgid: 'MSGID' + Date.now()
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[第三方API] 发送通知失败:', error);
    return new Response(
      JSON.stringify({
        message: '发送失败',
        response: {
          errcode: 1,
          errmsg: error.message
        }
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export { handleThirdPartyNotify, handleTestExpiringTelegram };
