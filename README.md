# llm-council

A personal Telegram bot. Send one message; it asks **ChatGPT, Claude, DeepSeek and
Gemini** in parallel, posts each raw answer as it lands, then posts a synthesis that
reconciles all four.
Models selected are based on testing to optimize cost.

Runs on Cloudflare Workers' free tier. You pay only for API tokens.

## Prerequisites

**API keys are not subscriptions.** ChatGPT Plus, Claude Pro, a DeepSeek account and
Gemini in the Google app grant no API access. You need four pay-as-you-go keys:

| Provider | Where | Note |
|---|---|---|
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | ~$10 credit |
| Anthropic | [platform.claude.com](https://platform.claude.com) | ~$10; also does the synthesis |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com) | ~$10 |
| Google | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | usable free tier |

Plus Node 18+ and a free Cloudflare account.

## Setup

**1. Create the bot**

- Telegram → **@BotFather** → `/newbot` → name it → save the HTTP API token.
- Telegram → **@userinfobot** → `/start` → note your numeric ID (a number, not your @handle).

**2. Deploy**

```bash
cd llm-council-telegram
npm install
npx wrangler login
./setup.sh              # prompts for 7 secrets, pipes each to wrangler, never echoes
npx wrangler deploy
./set-webhook.sh        # registers the webhook with its secret token
```

`secrets.txt` has `TELEGRAM_WEBHOOK_SECRET` pre-generated. Paste it when asked, then
delete the file.

**3. Check it**

```bash
curl https://llm-council.YOUR-SUBDOMAIN.workers.dev/health
```

Every `key_present` should be true. It never echoes a secret.

Then message the bot `/status`. If that replies, you're done.

## Using it

| Send | Get |
|---|---|
| any message | four raw answers, then a synthesis |
| `/raw <prompt>` | four raw answers, no synthesis — faster and cheaper |
| `/ask <model> <prompt>` | one model only: `chatgpt`, `claude`, `deepseek`, `gemini` |
| `/status` | configured models and key presence |
| `/help` | command list |

Answers post individually as each provider returns, so you're reading ChatGPT while
Gemini is still thinking. The synthesis lands last, which on a phone means it's the
message sitting at the bottom of the chat when you open it.

## How the synthesis is set up

Claude Opus 5 reconciles, in a separate call that sees all four answers. It is told
explicitly to treat all four equally — including the one from its own model family —
and its output is structured as: reconciled answer, then `DISAGREEMENTS`, then
`SINGLE-SOURCE`, then `UNVERIFIED`.

Those last two sections are the point. A claim only one model made is simultaneously
the most valuable and the most likely to be invented, so it gets flagged and judged
rather than quietly folded into a consensus. And agreement is treated as weak evidence,
not verification — four models trained on overlapping data can be wrong together.

Change the reconciler in `wrangler.toml`:

```toml
SYNTH_PROVIDER = "claude"        # or chatgpt | gemini | deepseek
SYNTH_MODEL    = "claude-opus-5"
```

## Changing models

Plain vars in `wrangler.toml`, editable in the Cloudflare dashboard without a redeploy:

```toml
OPENAI_MODEL   = "gpt-5.6"                 # or gpt-6-astra, gpt-5.6-terra
CLAUDE_MODEL   = "claude-opus-5"           # or claude-sonnet-5
DEEPSEEK_MODEL = "deepseek-v4-pro"         # or deepseek-flash
GEMINI_MODEL   = "gemini-3-flash-preview"  # gemini-2.5-* shuts down 16 Oct 2026
```

Model IDs move constantly and a retired one fails hard rather than degrading. `/status`
shows what's pinned. If you're copying model names from any guide written before this
year, check them first — `gemini-2.0-flash` was shut down on 1 June 2026 and
`deepseek-chat` was deprecated in July.

## Worth knowing

**Every prompt is a cold start.** No conversation history, no memory, no web search,
no follow-up questions. You can't say "now filter that list." That's the tradeoff for
the Telegram interface being this simple — if you need iteration or verification
against live data, that conversation belongs in Claude itself.

**Nothing verifies the output.** All four models will state stale prices, market caps
and dates with complete confidence. The synthesis flags what it can't confirm, but it
has no web access either. Treat the `UNVERIFIED` section as a to-do list, not a
disclaimer.

**DeepSeek is China-hosted.** Don't route confidential work material through the council.

**Cost** is a few cents per council run, four times whatever one query would cost. `/raw`
skips the fifth call. `/ask` is a quarter of the price.

**Security**: only your numeric Telegram ID is accepted, verified against a webhook
secret token; anything else gets a silent 200. Add a second ID by comma-separating
`ALLOWED_USER_ID`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Bot silent | Re-run `./set-webhook.sh` and read the `getWebhookInfo` output — `last_error_message` names the problem. |
| Bot silent, webhook fine | `ALLOWED_USER_ID` must be your numeric ID from @userinfobot, not your @handle. |
| One model always errors | The error text is posted verbatim in its message. `model_not_found` → stale ID; `insufficient_quota` → no credit on that API account. |
| `[Synthesis failed]` | `ANTHROPIC_API_KEY` missing or `SYNTH_MODEL` stale. The four raw answers still arrive. |
| Long answers cut off | They're split at 3900 chars across several messages. Telegram's limit is 4096. |
| Anything else | `npx wrangler tail` streams live logs. |
