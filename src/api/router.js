import { handleLogin, handleLogout, getUserFromRequest } from './handlers/auth.js';
import { handleGetConfig, handleUpdateConfig } from './handlers/config.js';
import { handleDashboardStats } from './handlers/dashboard.js';
import { handleThirdPartyNotify, handleTestExpiringTelegram } from './handlers/notify.js';
import { handleSubscriptions } from './handlers/subscriptions.js';
import { getConfig } from '../data/config.js';
import { handleTestNotification } from './handlers/test-notification.js';
import { handleExtraRoutes } from "./handlers/extras.js";
import { handleSetupWebhook } from './handlers/telegram-bot.js';

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice(4);
  const method = request.method;

  const config = await getConfig(env);

  if (path === '/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  if (path === '/logout' && (method === 'GET' || method === 'POST')) {
    return handleLogout();
  }

  // 第三方通知 API 使用独立 token 鉴权，必须在 JWT 门禁之前放行
  if (path.startsWith('/notify/')) {
    const thirdPartyResponse = await handleThirdPartyNotify(request, env, config, url);
    if (thirdPartyResponse) return thirdPartyResponse;
  }

  const { user } = await getUserFromRequest(request, env);
  if (!user && path !== '/login') {
    return new Response(
      JSON.stringify({ success: false, message: '未授权访问' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (path === '/telegram/setup-webhook' && method === 'POST') {
    return handleSetupWebhook(request, env);
  }

  if (path === '/config') {
    if (method === 'GET') return handleGetConfig(env);
    if (method === 'POST') return handleUpdateConfig(request, env);
  }

  if (path === '/dashboard/stats' && method === 'GET') {
    return handleDashboardStats(env, config);
  }

  if (path === '/test-notification' && method === 'POST') {
    return handleTestNotification(request, env);
  }

  // 管理员手动测试：把当前未来 30 天内到期的订阅按正式提醒格式推送到 Telegram
  if (path === '/test-expiring-telegram' && method === 'POST') {
    return handleTestExpiringTelegram(request, env);
  }

  // 备份 / 恢复
  if (path === '/backup' && method === 'GET') {
    const { handleExportBackup } = await import('./handlers/backup.js');
    return handleExportBackup(request, env);
  }
  if (path === '/restore' && method === 'POST') {
    const { handleImportBackup } = await import('./handlers/backup.js');
    return handleImportBackup(request, env);
  }

  // 新增路由：提醒规则 / 通知日志 / 调度日志（提醒规则 / 通知日志 / 调度日志）
  const extraResponse = await handleExtraRoutes(request, env, path);
  if (extraResponse) return extraResponse;

  const subscriptionResponse = await handleSubscriptions(request, env, path);
  if (subscriptionResponse) return subscriptionResponse;

  const thirdPartyResponse = await handleThirdPartyNotify(request, env, config, url);
  if (thirdPartyResponse) return thirdPartyResponse;

  return new Response(
    JSON.stringify({ success: false, message: '未找到请求的资源' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}

export { handleApiRequest };
