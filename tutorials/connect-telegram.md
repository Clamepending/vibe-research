---
id: connect-telegram
title: Connect Telegram
buildingId: telegram
summary: Let agents read and reply to Telegram messages from inside Vibe Research.
priority: normal
order: 10
---

# Connect Telegram

Hook Vibe Research up to a Telegram bot so agents can receive direct messages and reply from the Agent Inbox. The bot acts as the shared mailbox for every session running on this machine.

## 1. Create a bot with @BotFather

Open Telegram, start a chat with `@BotFather`, and send `/newbot`. Pick a display name and a username ending in `bot`. BotFather replies with an HTTP API token that looks like `123456:ABC-DEF...` — copy it.

## 2. Paste the token into Settings

Open the Settings view in Vibe Research and paste the token into the **Telegram bot token** field. If you prefer to edit on disk, set `telegramBotToken` in `~/.vibe-research/settings.json` and restart the server.

## 3. Enable the Telegram building

Open Agent Town and place the **Telegram** functional building, or toggle Telegram on in Settings. Vibe Research will start its watcher and the building will show as configured once the token is valid.

## 4. Send a test message

Message your new bot on Telegram. It should appear in the Agent Inbox within a few seconds, routed to the session that owns the chat.
