// @ts-check
// Telegram Bot API handlers are implemented in the service layer so that
// the webhook entry point and API router share exactly the same logic.
export {
  handleTelegramWebhook,
  handleSetupWebhook
} from '../../services/telegram-bot.js';
