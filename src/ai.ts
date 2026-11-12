import { useCallback, useEffect, useRef } from "react";
import type { Bridge } from "./ipc";
import type { Settings } from "./settings";

export type Provider = { id: string; protocol: "anthropic" | "openai"; base: string; model: string };

/** Ready services; any other OpenAI-compatible address works through "custom". */
export const PROVIDERS: { id: string; name: string; protocol: "anthropic" | "openai"; base: string; model: string; keyUrl?: string; note: string }[] = [
  { id: "anthropic", name: "Claude", protocol: "anthropic", base: "https://api.anthropic.com/v1", model: "claude-opus-5-5", keyUrl: "https://platform.claude.com/settings/keys", note: "Anthropic, платно" },
  { id: "groq", name: "Groq", protocol: "openai", base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", keyUrl: "https://console.groq.com/keys", note: "есть бесплатный лимит, им же — диктовка" },
  { id: "gemini", name: "Gemini", protocol: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", keyUrl: "https://aistudio.google.com/apikey", note: "бесплатный тариф AI Studio" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai", base: "https://openrouter.ai/api/v1", model: "openrouter/auto", keyUrl: "https://openrouter.ai/keys", note: "много моделей, есть бесплатные" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai", base: "https://api.deepseek.com/v1", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", note: "платно" },
  { id: "openai", name: "OpenAI", protocol: "openai", base: "https://api.openai.com/v1", model: "gpt-5", keyUrl: "https://platform.openai.com/api-keys", note: "платно" },
  { id: "custom", name: "Свой адрес", protocol: "openai", base: "http://127.0.0.1:11434/v1", model: "", note: "любой OpenAI-совместимый сервер" },
];

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];

export function providerOf(s: Settings): Provider {
  const id = (s.aiProvider as string) || "anthropic";
  const preset = PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  return {
    id,
    protocol: preset.protocol,
    base: ((s[`aiBase_${id}`] as string) || preset.base).trim(),
    model: ((s[`aiModel_${id}`] as string) || preset.model).trim(),
  };
}

/** A chat model close to the old one: same family word (flash, sonnet, mini…), newest name first. */
export function pickModel(list: string[], old: string): string | null {
  const ok = list.filter((m) => !/embed|tts|image|audio|live|vision|whisper|guard|moderation|transcribe|realtime|search/i.test(m) && m !== old);
  if (!ok.length) return null;
  const family = old.toLowerCase().match(/(?:^|[-_./:])(flash-lite|flash|pro|sonnet|haiku|opus|mini|nano|chat|instant|versatile)(?=$|[-_./:])/)?.[1];
  const pool = (family && ok.filter((m) => new RegExp(`(?:^|[-_./:])${family}(?=$|[-_./:])`).test(m.toLowerCase()) && (family !== "flash" || !m.includes("flash-lite")))) || [];
  const sorted = (pool.length ? pool : ok).slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return sorted.find((m) => !/preview|exp/i.test(m)) ?? sorted[0];
}

/** A lighter sibling for a busy model: flash → flash-lite, pro → flash, and so on. */
export function lighterModel(list: string[], old: string): string | null {
  const o = old.toLowerCase();
  const want = /flash-lite/.test(o) ? null : /flash/.test(o) ? "flash-lite" : /(^|-)pro($|-)/.test(o) ? "flash" : /opus/.test(o) ? "sonnet" : /sonnet/.test(o) ? "haiku" : null;
  if (!want) return null;
  return pickModel(list, `x-${want}`);
}

export type AiDoc = { name: string; text: string };
export type AiMsg = { role: "user" | "assistant"; text: string; images?: string[]; docs?: AiDoc[] };

/** What the model reads: attached documents go before the question. */
export const msgText = (m: AiMsg) =>
  m.docs?.length ? `${m.docs.map((d) => `<документ name="${d.name}">\n${d.text}\n</документ>`).join("\n\n")}\n\n${m.text}` : m.text;

/** Runs a streamed request; `onText` gets the whole text so far. */
export function useAi(api: Bridge | null) {
  const handlers = useRef(new Map<string, { onText: (t: string) => void; onDone: (err: string | null) => void; text: string }>());
  useEffect(() => {
    if (!api) return;
    const off1 = api.on("ai_delta", (d) => {
      const h = handlers.current.get(d.id);
      if (!h) return;
      h.text += d.text;
      h.onText(h.text);
    });
    const off2 = api.on("ai_done", (d) => {
      const h = handlers.current.get(d.id);
      handlers.current.delete(d.id);
      h?.onDone(d.error);
    });
    return () => {
      off1();
      off2();
    };
  }, [api]);

  const run = useCallback(
    (provider: Provider, system: string, messages: AiMsg[], onText: (t: string) => void, onDone: (err: string | null) => void, retried = false, busyRetries = 0) => {
      let stop: (() => void) | null = null;
      let cancelled = false;
      let got = false;
      const text = (t: string) => {
        got = true;
        onText(t);
      };
      const done = (err: string | null) => {
        // The service is busy right now (503/529, "high demand", "overloaded"):
        // wait a moment and ask again, then try a lighter model of the same family once.
        if (err && !got && !cancelled && busyRetries < 3 && /\((503|529|500)\)|high demand|overloaded|unavailable|temporarily/i.test(err)) {
          const n = busyRetries + 1;
          window.setTimeout(() => {
            if (cancelled) return;
            if (n < 3) {
              stop = run(provider, system, messages, onText, onDone, retried, n);
              return;
            }
            api
              ?.call<string[]>("ai_models", { provider })
              .then((list) => {
                const next = lighterModel(list ?? [], provider.model);
                if (!next || cancelled) return onDone(err);
                stop = run({ ...provider, model: next }, system, messages, onText, onDone, true, n);
              })
              .catch(() => onDone(err));
          }, n * 1500);
          return;
        }
        // A retired model: pick a live one from the provider's list, save it and try once more.
        if (err && !retried && !cancelled && /Нет такой модели|no longer available|not found|does not exist/i.test(err)) {
          api
            ?.call<string[]>("ai_models", { provider })
            .then((list) => {
              const next = pickModel(list ?? [], provider.model);
              if (!next || cancelled) return onDone(err);
              api.call("settings_set", { patch: { [`aiModel_${provider.id}`]: next } });
              stop = run({ ...provider, model: next }, system, messages, onText, onDone, true);
            })
            .catch(() => onDone(err));
          return;
        }
        onDone(err);
      };
      stop = start(provider, system, messages, text, done);
      return () => {
        cancelled = true;
        stop?.();
      };
    },
    [api],
  );
  const start = useCallback(
    (provider: Provider, system: string, messages: AiMsg[], onText: (t: string) => void, onDone: (err: string | null) => void) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      handlers.current.set(id, { onText, onDone, text: "" });
      api?.call("ai_chat", {
        id,
        provider,
        system,
        messages: messages.map((m) => ({ role: m.role, text: msgText(m), images: m.images ?? [] })),
      }).catch((e) => {
        handlers.current.delete(id);
        onDone(String(e));
      });
      return () => api?.call("ai_cancel", { id });
    },
    [api],
  );
  return run;
}
