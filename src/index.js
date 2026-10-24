/**
 * llm-council — a personal Telegram bot that fans one prompt out to four models
 * and posts each raw answer as it lands, followed by a synthesis.
 *
 *   POST /telegram   Telegram webhook (secret-token header + user allowlist)
 *   GET  /health     Liveness + config check. Never echoes secrets.
 *
 * Council: ChatGPT, Claude, DeepSeek, Gemini — all four queried in parallel,
 * each with no knowledge of the others. The synthesizer runs afterwards as a
 * separate call and is told not to privilege any particular answer, including
 * one written by its own model.
 *
 * Commands:
 *   <any text>            full council + synthesis
 *   /raw <prompt>         four raw answers, no synthesis (faster, cheaper)
 *   /ask <name> <prompt>  a single model: chatgpt | claude | deepseek | gemini
 *   /status               configured models and key presence
 *   /help
 */

// Bump this string whenever you edit this file. It prints on every request,
// so `wrangler tail` proves which version is actually live.
const BUILD = "council-v9 built 2026-10-24T11:04:39Z";

const DEFAULTS = {
  OPENAI_MODEL: "gpt-5.6",
  CLAUDE_MODEL: "claude-opus-5",
  DEEPSEEK_MODEL: "deepseek-v4-pro",
  GEMINI_MODEL: "gemini-3-flash-preview",
  SYNTH_PROVIDER: "claude",
  SYNTH_MODEL: "claude-opus-5",
  COUNCIL_TIMEOUT_MS: "180000",
  // Thinking + visible text share this budget on every Claude 5+ model.
  CLAUDE_MAX_TOKENS: "16000",
  // "", low, medium, high, xhigh, max. Lower effort = less thinking = faster.
  CLAUDE_EFFORT: "low",
  // The synthesizer's instructions. The user has already read all four answers,
  // so restating them is the main source of bloat — this forbids it.
  SYNTH_SYSTEM: [
    "You are reconciling independent answers from several AI models that could not see each other's work. The user has already read every one of them.",
    "Total 150 words or fewer. Plain text only: no markdown, no asterisks, no headers.",
    "Write, in this order:",
    "1. The verdict, in one or two sentences. Do not restate, summarize or recap what the models said.",
    "2. DISAGREEMENTS: real factual conflicts only, one line each. Ignore differences of wording or emphasis.",
    "3. SINGLE-SOURCE: claims only one model made, one line each, each marked likely-real or likely-invented.",
    "4. UNVERIFIED: figures or dates you cannot confirm, one line total.",
    "Omit any section that would be empty rather than writing none. If the models agreed and added nothing to each other, say exactly that in one line and stop.",
    "Treat all models equally; one may share your own model family, which earns it nothing. Agreement between models is weak evidence, never verification.",
  ].join(" "),
  // Sent as a system prompt to all four council models so you only ever type
  // your question. Long enough to show reasoning, short enough to read on a
  // phone — a one-word verdict gives the synthesizer nothing to reconcile.
  COUNCIL_SYSTEM: [
    "Answer in 120 words or fewer.",
    "Lead with your verdict or direct answer in the first sentence. Then give only the two or three reasons that actually drive it, with any key numbers.",
    "No preamble, no restating the question, no closing summary, no disclaimers about your limitations as a model.",
    "Plain text only: no asterisks, no bold, no markdown headers, no bullet lists. Your answer is delivered as unformatted text and markdown shows up as literal characters.",
    "State any assumption your answer depends on in a short clause rather than hedging throughout.",
    "If you cannot answer, say so in one sentence and state what you would need.",
  ].join(" "),
};

const cfg = (env, key) => env[key] || DEFAULTS[key];

// Elapsed-time logging so `wrangler tail` shows exactly which stage overruns
// Cloudflare's background-task budget.
const T0 = Symbol("t0");
function mark(label, state) {
  const now = Date.now();
  if (!state[T0]) state[T0] = now;
  console.log(`[t+${String(now - state[T0]).padStart(6)}ms] ${label}`);
}
const timeoutMs = (env) => Number(cfg(env, "COUNCIL_TIMEOUT_MS"));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time compare so the webhook secret can't be probed byte by byte. */
function secretMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Parse a provider response, turning any failure into a readable Error. */
async function readJson(res, label) {
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Rate limits and gateway errors often come back as HTML, not JSON.
    throw new Error(`${label} HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`${label} HTTP ${res.status}: ${data?.error?.message ?? raw.slice(0, 300)}`);
  }
  return data;
}

/** OpenAI and DeepSeek share a wire format; only host, key and model differ. */
function openAiStyle({ label, url, keyVar, modelKey }) {
  return async (prompt, env, modelOverride, system) => {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env[keyVar]}` },
      body: JSON.stringify({
        model: modelOverride || cfg(env, modelKey),
        messages,
      }),
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
    const data = await readJson(res, label);
    return (data.choices?.[0]?.message?.content ?? "").trim();
  };
}

const callOpenAI = openAiStyle({
  label: "OpenAI",
  url: "https://api.openai.com/v1/chat/completions",
  keyVar: "OPENAI_API_KEY",
  modelKey: "OPENAI_MODEL",
});

const callDeepSeek = openAiStyle({
  label: "DeepSeek",
  url: "https://api.deepseek.com/chat/completions",
  keyVar: "DEEPSEEK_API_KEY",
  modelKey: "DEEPSEEK_MODEL",
});

async function callClaude(prompt, env, modelOverride, system) {
  // Claude 5+ models run adaptive thinking by default and cannot turn it off,
  // and max_tokens is a hard cap on thinking PLUS visible text. Size it for a
  // hard reasoning task — too low and the model spends the whole budget
  // thinking and returns stop_reason "max_tokens" with no text at all.
  const body = {
    model: modelOverride || cfg(env, "CLAUDE_MODEL"),
    max_tokens: Number(cfg(env, "CLAUDE_MAX_TOKENS")),
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;
  const effort = String(cfg(env, "CLAUDE_EFFORT") ?? "").trim();
  if (effort) body.output_config = { effort };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs(env)),
  });
  let data;
  try {
    data = await readJson(res, "Anthropic");
  } catch (err) {
    // If this API version doesn't take output_config, drop it and retry once
    // rather than failing the whole synthesis over an optional field.
    if (!effort || !/output_config|effort/i.test(String(err?.message))) throw err;
    delete body.output_config;
    const retry = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
    data = await readJson(retry, "Anthropic");
  }
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) {
    if (data.stop_reason === "max_tokens") {
      throw new Error(
        `${body.model} used all ${body.max_tokens} tokens on thinking and returned no text. ` +
        "Raise CLAUDE_MAX_TOKENS in wrangler.toml.",
      );
    }
    throw new Error(`Anthropic returned no text (stop_reason: ${data.stop_reason})`);
  }
  return text;
}

async function callGemini(prompt, env, modelOverride, system) {
  const model = modelOverride || cfg(env, "GEMINI_MODEL");
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs(env)),
    },
  );
  const data = await readJson(res, "Gemini");

  // Gemini 3 can return several parts, some of which carry no text.
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  if (!text) {
    throw new Error(`Gemini returned no text (finishReason: ${data?.candidates?.[0]?.finishReason ?? "unknown"})`);
  }
  return text;
}

const PROVIDERS = {
  chatgpt: { label: "ChatGPT", modelKey: "OPENAI_MODEL", keyVar: "OPENAI_API_KEY", call: callOpenAI },
  claude: { label: "Claude", modelKey: "CLAUDE_MODEL", keyVar: "ANTHROPIC_API_KEY", call: callClaude },
  deepseek: { label: "DeepSeek", modelKey: "DEEPSEEK_MODEL", keyVar: "DEEPSEEK_API_KEY", call: callDeepSeek },
  gemini: { label: "Gemini", modelKey: "GEMINI_MODEL", keyVar: "GEMINI_API_KEY", call: callGemini },
};

const ORDER = ["chatgpt", "claude", "deepseek", "gemini"];

function statusPayload(env) {
  return {
    ok: true,
    service: "llm-council",
    build: BUILD,
    telegram_configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.ALLOWED_USER_ID),
    council: Object.fromEntries(
      ORDER.map((n) => [n, { model: cfg(env, PROVIDERS[n].modelKey), key_present: Boolean(env[PROVIDERS[n].keyVar]) }]),
    ),
    synthesizer: { provider: cfg(env, "SYNTH_PROVIDER"), model: cfg(env, "SYNTH_MODEL") },
    timeout_ms: timeoutMs(env),
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegram(chatId, text, env) {
  const CHUNK = 3900; // Telegram's hard limit is 4096.
  const body = String(text || "(empty)");
  for (let i = 0; i < body.length; i += CHUNK) {
    // Plain text on purpose: Markdown parse_mode rejects unbalanced * and _,
    // which model output produces constantly.
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: body.slice(i, i + CHUNK),
        disable_web_page_preview: true,
      }),
    });
  }
}



/** One synthesis attempt with a named provider. Models that take a real system
 *  prompt get one; the others get it prepended to the user turn. */
function synthesizeWith(provider, model, input, env) {
  const sys = cfg(env, "SYNTH_SYSTEM");
  if (provider === "claude") return callClaude(input, env, model, sys);
  if (provider === "gemini") return callGemini(input, env, model, sys);
  if (provider === "chatgpt") return callOpenAI(`${sys}\n\n${input}`, env, model);
  if (provider === "deepseek") return callDeepSeek(`${sys}\n\n${input}`, env, model);
  throw new Error(`Unknown synth provider: ${provider}`);
}

/**
 * Synthesize, falling back to another provider if the configured one fails.
 * Matters because ANTHROPIC_API_KEY does double duty: it answers as Claude in
 * the council AND reconciles. Without a fallback, one dead key costs you both.
 * Returns { text, model, fellBackFrom }.
 */
async function synthesize(prompt, transcript, env) {
  const raw = String(cfg(env, "SYNTH_PROVIDER") ?? "").trim().toLowerCase();
  // A typo or stray whitespace in SYNTH_PROVIDER must not take down the whole
  // synthesis — fall through to the default order instead.
  const configured = PROVIDERS[raw] ? raw : "claude";
  const order = [configured, ...ORDER.filter((n) => n !== configured)];

  const errors = [];
  if (raw && raw !== configured) errors.push(`SYNTH_PROVIDER "${raw}" is not a known provider`);

  // SYNTH_MODEL and SYNTH_PROVIDER are separate vars, so changing one without
  // the other sends e.g. a Claude model ID to Google's endpoint — a 404 that
  // reads like a broken synthesizer. Ignore a mismatched SYNTH_MODEL instead.
  const PREFIX = { claude: "claude", gemini: "gemini", deepseek: "deepseek", chatgpt: "gpt" };
  const synthModel = String(cfg(env, "SYNTH_MODEL") ?? "").trim();
  const synthModelFits = synthModel.toLowerCase().startsWith(PREFIX[configured]);
  if (synthModel && !synthModelFits) {
    errors.push(`SYNTH_MODEL "${synthModel}" is not a ${configured} model; using ${cfg(env, PROVIDERS[configured].modelKey)}`);
  }

  for (const provider of order) {
    if (!env[PROVIDERS[provider].keyVar]) continue; // no key, don't bother
    const model =
      provider === configured && synthModel && synthModelFits
        ? synthModel
        : cfg(env, PROVIDERS[provider].modelKey);
    const input = `The user asked:\n${prompt}\n\nThe independent answers:\n\n${transcript}`;
    try {
      const text = await synthesizeWith(provider, model, input, env);
      return { text, model, fellBackFrom: provider === configured ? null : configured };
    } catch (err) {
      errors.push(`${provider}: ${err?.message ?? err}`);
    }
  }
  throw new Error(`every synthesizer failed — ${errors.join(" | ")}`);
}

/** Query one model and post its answer the moment it returns. Never throws. */
async function runOne(name, prompt, chatId, env) {
  const p = PROVIDERS[name];
  const model = cfg(env, p.modelKey);

  const clock = runOne.clock;
  mark(`${p.label} start`, clock);
  let answer;
  let ok = true;
  try {
    // Same system prompt to all four, so every answer comes back comparably
    // short and the only thing you type is your question.
    answer = await p.call(prompt, env, undefined, cfg(env, "COUNCIL_SYSTEM") || undefined);
  } catch (err) {
    answer = `[ERROR from ${p.label}: ${err?.message ?? err}]`;
    ok = false;
  }

  mark(`${p.label} replied`, clock);
  mark(`${p.label} done (${ok ? "ok" : "ERROR"}, ${answer.length} chars)`, clock);

  // A failed Telegram send must not abort the council — we still have the
  // answer in hand and the synthesis can use it.
  try {
    await sendTelegram(chatId, `${p.label.toUpperCase()} (${model})\n\n${answer}`, env);
  } catch {
    /* delivery failed; the answer still counts toward the synthesis */
  }

  return { name, label: p.label, model, answer, ok };
}

async function runCouncil(prompt, chatId, env, { synthesize: doSynth = true } = {}) {
  const clock = {};
  runOne.clock = clock;
  mark("council start", clock);
  await sendTelegram(chatId, `Asking ${ORDER.map((n) => PROVIDERS[n].label).join(", ")}…`, env);

  // Each answer posts as it lands rather than waiting for the slowest.
  // runOne never throws, but allSettled guarantees one bad apple can't abort
  // the others even if that invariant is broken by a future edit.
  const settled = await Promise.allSettled(ORDER.map((n) => runOne(n, prompt, chatId, env)));
  mark("all four returned", clock);
  const results = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);

  if (!doSynth) return;

  const good = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map((r) => r.label);

  // Nothing to reconcile — don't pay for a synthesis of four error strings.
  if (good.length === 0) {
    return sendTelegram(chatId, "All models failed. No synthesis. See the errors above.", env);
  }

  // A single answer needs no reconciling either.
  if (good.length === 1) {
    return sendTelegram(
      chatId,
      `Only ${good[0].label} answered (failed: ${failed.join(", ") || "none"}). ` +
        `Nothing to reconcile — its answer above stands on its own.`,
      env,
    );
  }

  // Feed the synthesizer only the real answers, plus a note on what's missing,
  // so it reconciles 2 or 3 opinions without being told to weigh error text.
  let transcript = good
    .map((r) => `--- ${r.label.toUpperCase()} (${r.model}) ---\n${r.answer}`)
    .join("\n\n");
  if (failed.length) {
    transcript += `\n\n[Note: ${failed.join(", ")} failed to respond. Reconcile only the ${good.length} answers above and say at the end which models were missing.]`;
  }

  // Cloudflare caps how long waitUntil() may run after the response is sent,
  // and four model calls plus a reasoning-heavy synthesis exceeds it. Hand the
  // synthesis to a fresh invocation of this same Worker so it gets its own
  // full budget. The dispatch returns immediately; the work continues there.
  mark("starting synthesis", clock);
  await runSynthesis({ chatId, prompt, transcript, failed, count: good.length }, env);
  mark("synthesis complete", clock);
}

/** Reconcile the answers and post the result. */
async function runSynthesis({ chatId, prompt, transcript, failed = [], count }, env) {
  const clock = {};
  await sendTelegram(chatId, `Reconciling ${count} answers\u2026`, env);

  let header = "";
  let synthesis;
  try {
    mark("calling synthesizer", clock);
    const out = await synthesize(prompt, transcript, env);
    mark("synthesizer returned", clock);
    synthesis = out.text;
    header = `SYNTHESIS (${out.model}`;
    header += out.fellBackFrom ? `, fallback \u2014 ${out.fellBackFrom} failed)` : ")";
  } catch (err) {
    mark(`synthesizer failed: ${err?.message ?? err}`, clock);
    synthesis = `[Synthesis failed: ${err?.message ?? err}]`;
    header = "SYNTHESIS";
  }

  if (failed.length) synthesis = `[${failed.join(", ")} did not respond]\n\n${synthesis}`;

  try {
    await sendTelegram(chatId, `${header}\n\n${synthesis}`, env);
  } catch (err) {
    try {
      await sendTelegram(chatId, `Synthesis ready but could not be delivered: ${err?.message ?? err}`, env);
    } catch {
      /* nothing further we can do from here */
    }
  }
}

const HELP = `Send any message and I'll ask ChatGPT, Claude, DeepSeek and Gemini, then post a synthesis.

/raw <prompt>          four answers, no synthesis (faster, cheaper)
/ask <model> <prompt>  one model only: chatgpt | claude | deepseek | gemini
/status                configured models and keys
/help                  this message`;

async function handleMessage(text, chatId, env) {
  if (text.startsWith("/start") || text.startsWith("/help")) {
    return sendTelegram(chatId, HELP, env);
  }

  if (text.startsWith("/status")) {
    const s = statusPayload(env);
    const lines = ORDER.map(
      (n) => `${PROVIDERS[n].label.padEnd(9)} ${s.council[n].model}${s.council[n].key_present ? "" : "  [NO KEY]"}`,
    );
    lines.push(`Synth     ${s.synthesizer.model} (${s.synthesizer.provider})`);
    lines.push(`Timeout   ${s.timeout_ms / 1000}s`);
    lines.push(`Build     ${s.build}`);
    return sendTelegram(chatId, lines.join("\n"), env);
  }

  if (text.startsWith("/raw")) {
    const prompt = text.slice(4).trim();
    if (!prompt) return sendTelegram(chatId, "Usage: /raw <prompt>", env);
    return runCouncil(prompt, chatId, env, { synthesize: false });
  }

  if (text.startsWith("/ask")) {
    const rest = text.slice(4).trim();
    const name = rest.split(/\s+/)[0]?.toLowerCase();
    const prompt = rest.slice(name?.length ?? 0).trim();
    if (!PROVIDERS[name] || !prompt) {
      return sendTelegram(chatId, `Usage: /ask <${ORDER.join("|")}> <prompt>`, env);
    }
    return runOne(name, prompt, chatId, env).then(() => undefined);
  }

  if (text.startsWith("/")) {
    return sendTelegram(chatId, `Unknown command.\n\n${HELP}`, env);
  }

  return runCouncil(text, chatId, env);
}

function isAllowed(userId, env) {
  return String(env.ALLOWED_USER_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(userId));
}

async function handleTelegram(request, env, ctx) {
  // Always 200 so Telegram never retries, and never reveal why a message was ignored.
  const ok = new Response("OK", { status: 200 });
  if (request.method !== "POST") return ok;
  if (!secretMatch(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", env.TELEGRAM_WEBHOOK_SECRET ?? "")) {
    return ok;
  }

  const update = await request.json().catch(() => null);
  const msg = update?.message;
  if (!msg?.text || !isAllowed(msg.from?.id, env)) return ok;

  // Telegram retries a webhook it believes failed, which would run the whole
  // council twice. Ignore anything that already sat in the queue a while.
  const ageSeconds = Math.floor(Date.now() / 1000) - (msg.date ?? 0);
  if (msg.date && ageSeconds > 90) {
    console.log(`ignoring stale update, ${ageSeconds}s old`);
    return ok;
  }

  // Run inside the request rather than ctx.waitUntil(): Cloudflare cancels
  // background tasks on a tight budget after the response is sent, and the
  // council plus synthesis exceeds it. Awaiting here keeps the invocation
  // alive for the whole chain.
  try {
    await handleMessage(msg.text.trim(), msg.chat.id, env);
  } catch (err) {
    try {
      await sendTelegram(msg.chat.id, `[Worker error: ${err?.message ?? err}]`, env);
    } catch {
      /* nothing further we can do */
    }
  }
  return ok;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    console.log(`=== ${BUILD} === ${request.method} ${path}`);
    if (path === "/health") return json(statusPayload(env));
    if (path === "/telegram") return handleTelegram(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
};