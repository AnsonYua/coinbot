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

export async function sendSignalMessage(config, text) {
  return sendTelegram(config.signalBotToken, config.signalChatId, text);
}

export async function sendActionMessage(config, text) {
  return sendTelegram(config.actionBotToken, config.actionChatId, text);
}
