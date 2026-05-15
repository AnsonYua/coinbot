async function sendTelegram(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram send failed: HTTP ${response.status}`);
  }
  return response.json();
}

export function escapeTelegramHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function safeTelegram(sendFn) {
  try {
    await sendFn();
    return { sent: true, error: null };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendSignalMessage(config, text) {
  return sendTelegram(config.signalBotToken, config.signalChatId, text);
}

export async function sendActionMessage(config, text) {
  return sendTelegram(config.actionBotToken, config.actionChatId, text);
}
