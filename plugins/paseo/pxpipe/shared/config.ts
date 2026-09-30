import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Plugin default scope: pxpipe 0.13.2's default, the strongest exact-string readers.
 * pxpipe 0.14.0 also turns on claude-opus-5-5 (dense hex 3/15) and every Gemini id.
 */
export const DEFAULT_MODELS = ["claude-fable-5", "gemini-3.6-flash", "gemini-3.7-flash"];

export interface ModelChoice {
  id: string;
  label: string;
  /** Exact-string recall on imaged pages, from pxpipe's README benchmark table. */
  quality: string;
}

/** Mirrors the pxpipe dashboard chip catalog (dist/dashboard/fragments.js MODEL_CATALOG). */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  {
    id: "claude-fable-5",
    label: "Fable 5",
    quality: "Best reader. Dense hex 13/15, gist 98/98. Also covers claude-fable-5-1 (hex 6/15, gist 95/98).",
  },
  { id: "claude-opus-5-5", label: "Opus 5.5", quality: "Dense hex 3/15, gist 94/98." },
  { id: "claude-opus-5", label: "Opus 5", quality: "Dense hex 2/15, gist 94/98." },
  { id: "gemini", label: "Gemini (all versions)", quality: "Gemini 3.6/3.7 Flash: dense hex 14/15." },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", quality: "Narrows scope when the family is off." },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", quality: "Narrows scope when the family is off." },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", quality: "Narrows scope when the family is off." },
  { id: "gpt-5.6-sol", label: "GPT 5.6 Sol", quality: "Dense hex 0/15, gist 83/98." },
  { id: "gpt-5.5", label: "GPT 5.5", quality: "pxpipe reports degraded reading of imaged history." },
  { id: "grok-4.6", label: "Grok 4.6", quality: "Dense hex 0/15, gist 97/98." },
  { id: "grok-4.5", label: "Grok 4.5", quality: "Dense hex 0/15, gist 97/98." },
];

const optionalUrl = z.union([z.literal(""), z.url()]);

export const pxpipeConfig = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Run the managed pxpipe process. */
    enabled: z.boolean().default(true),
    /** pxpipe kill switch. Off forwards every request unchanged but keeps logging usage. */
    compression: z.boolean().default(true),
    /** Model bases pxpipe may image. Empty means compress nothing. */
    models: z.array(z.string().trim().min(1)).default(DEFAULT_MODELS),
    /** Paseo provider IDs whose agents get ANTHROPIC_BASE_URL pointed at pxpipe. */
    routedProviders: z.array(z.string().trim().min(1)).default(["omp", "claude"]),
    port: z.number().int().min(1024).max(65535).default(47821),
    /** Use a pxpipe that is already listening on the port instead of starting one. */
    adoptExisting: z.boolean().default(true),
    /** Optional argv override, split on whitespace. Empty uses the bundled pxpipe-proxy. */
    command: z.string().trim().default(""),
    anthropicUpstream: optionalUrl.default(""),
    openaiUpstream: optionalUrl.default(""),
    /** PXPIPE_RENDER_CACHE_BYTES in MiB. 0 disables the render cache. */
    renderCacheMb: z.number().int().min(0).max(4096).default(64),
    /** PXPIPE_MAX_REQUEST_BYTES in MiB. */
    maxRequestMb: z.number().int().min(1).max(1024).default(16),
    /** PXPIPE_GPT_HISTORY_MAX_IMAGES. 0 keeps pxpipe's per-profile default. */
    gptHistoryMaxImages: z.number().int().min(0).max(100).default(0),
    /** PXPIPE_SESSION_STATE. Off disables persisted history-freeze state. */
    sessionState: z.boolean().default(true),
    /** PXPIPE_DEBUG_CAPTURE_4XX. Persists 4xx request bodies, which can contain prompts. */
    captureErrorBodies: z.boolean().default(false),
    /** Extra KEY=VALUE lines for any other pxpipe environment variable. */
    extraEnv: z.string().default(""),
  }),
});

export type PxpipeConfig = z.output<typeof pxpipeConfig.schema>;

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

/** Parses the extra environment text. Returns the map, or the first invalid line. */
export function parseExtraEnv(text: string): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!ENV_KEY.test(key)) {
      return { ok: false, error: `Line ${index + 1}: expected KEY=VALUE` };
    }
    env[key] = line.slice(separator + 1).trim();
  }
  return { ok: true, env };
}
