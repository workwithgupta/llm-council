#!/usr/bin/env bash
# Prompts for each secret and pipes it to wrangler. Values are never echoed.
set -euo pipefail

command -v npx >/dev/null || { echo "Node.js 18+ required."; exit 1; }

put() {
  local name="$1" desc="$2"
  echo
  echo "── $name"
  echo "   $desc"
  read -rsp "   value: " val; echo
  if [ -z "$val" ]; then echo "   required, try again"; put "$name" "$desc"; return 0; fi
  printf '%s' "$val" | npx wrangler secret put "$name" >/dev/null
  echo "   set"
}

echo "=== Telegram ==="
put TELEGRAM_BOT_TOKEN      "from @BotFather"
put TELEGRAM_WEBHOOK_SECRET "from secrets.txt"
put ALLOWED_USER_ID         "numeric ID from @userinfobot (comma-separate for more than one)"

echo
echo "=== The council ==="
put OPENAI_API_KEY   "platform.openai.com/api-keys"
put ANTHROPIC_API_KEY "platform.claude.com — also does the synthesis"
put DEEPSEEK_API_KEY "platform.deepseek.com"
put GEMINI_API_KEY   "aistudio.google.com/apikey"

echo
echo "Done. Next:  npx wrangler deploy  &&  ./set-webhook.sh"
