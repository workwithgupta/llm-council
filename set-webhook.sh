#!/usr/bin/env bash
# Point the bot at the deployed Worker. Run after `npx wrangler deploy`.
set -euo pipefail

read -rp  "Worker URL (e.g. https://llm-council.you.workers.dev): " WORKER
read -rsp "TELEGRAM_BOT_TOKEN: " TOKEN; echo
read -rsp "TELEGRAM_WEBHOOK_SECRET: " HOOK; echo

curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${WORKER}/telegram\",\"secret_token\":\"${HOOK}\",\"allowed_updates\":[\"message\"]}"
echo
echo "--- getWebhookInfo ---"
curl -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
echo
