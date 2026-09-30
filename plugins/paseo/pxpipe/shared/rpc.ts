import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const nullableNumber = z.number().nullable();

export const ProxyStateSchema = z.enum(["disabled", "starting", "running", "stopped", "failed"]);

export const StatusSchema = z.object({
  state: ProxyStateSchema,
  pid: z.number().nullable(),
  /** A pxpipe started outside Paseo on the port: used when `adopted`, otherwise only blocking the port. */
  external: z
    .object({
      pid: z.number().nullable(),
      version: z.string().nullable(),
      command: z.string().nullable(),
      adopted: z.boolean(),
    })
    .nullable(),
  port: z.number(),
  baseUrl: z.string(),
  command: z.array(z.string()),
  startedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Live kill-switch state reported by pxpipe; null when unreachable. */
  compressionEnabled: z.boolean().nullable(),
  logTail: z.array(z.string()),
});
export type Status = z.infer<typeof StatusSchema>;

export const ModelTotalsSchema = z.object({
  model: z.string(),
  requests: z.number(),
  compressed: z.number(),
  /** Rows with a successful count_tokens baseline probe. */
  measured: z.number(),
  /** Raw input tokens pxpipe's baseline probe counted for the original bodies. */
  baselineTokens: z.number(),
  /** Raw input tokens billed for the same rows: input + cache writes + cache reads. */
  actualTokens: z.number(),
  outputTokens: z.number(),
  /** Cache-weighted input cost of the text counterfactual, in base-input-token units. Anthropic rows only. */
  baselineWeighted: z.number(),
  /** Cache-weighted input cost actually billed for the same rows. */
  actualWeighted: z.number(),
});
export type ModelTotals = z.infer<typeof ModelTotalsSchema>;

export const StatsSchema = z.object({
  /** Totals across every row in pxpipe's events log. */
  log: z.object({
    path: z.string(),
    rows: z.number(),
    models: z.array(ModelTotalsSchema),
  }),
  /** Pricing pxpipe applies to weighted tokens; from the running pxpipe when reachable. */
  pricing: z.object({ inputPerMtok: z.number(), source: z.string() }),
});
export type Stats = z.infer<typeof StatsSchema>;

export const RecentRowSchema = z.object({
  /** Unix epoch milliseconds. */
  ts: z.number(),
  model: z.string().nullable(),
  status: z.number(),
  compressed: z.boolean(),
  inputTokens: nullableNumber,
  outputTokens: nullableNumber,
  cacheRead: nullableNumber,
  cacheCreate: nullableNumber,
  baselineInput: nullableNumber,
  actualInput: nullableNumber,
  imageIds: z.array(z.number()),
});
export type RecentRow = z.infer<typeof RecentRowSchema>;

export const SessionRowSchema = z.object({
  id: z.string(),
  project: z.string().nullable(),
  lastSeen: z.string(),
  requestCount: z.number(),
  tokensSavedEst: z.number(),
  cacheReadTokens: z.number(),
  preview: z.string().nullable(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

export const getStatus = defineRpc({
  name: "pxpipe.status",
  input: z.object({}),
  output: StatusSchema,
});

/** Stops a pxpipe started outside Paseo on the port and starts a plugin-owned one. */
export const takeOverProxy = defineRpc({
  name: "pxpipe.take_over",
  input: z.object({}),
  output: StatusSchema,
});

export const restartProxy = defineRpc({
  name: "pxpipe.restart",
  input: z.object({}),
  output: StatusSchema,
});

export const getStats = defineRpc({
  name: "pxpipe.stats",
  input: z.object({}),
  output: StatsSchema,
});

export const getRecent = defineRpc({
  name: "pxpipe.recent",
  input: z.object({ limit: z.number().int().min(1).max(50) }),
  output: z.object({ rows: z.array(RecentRowSchema) }),
});

export const getSessions = defineRpc({
  name: "pxpipe.sessions",
  input: z.object({ limit: z.number().int().min(1).max(100) }),
  output: z.object({ sessions: z.array(SessionRowSchema) }),
});

export const getPreview = defineRpc({
  name: "pxpipe.preview",
  input: z.object({ imageId: z.number().int().nonnegative() }),
  output: z.object({
    imageId: z.number(),
    /** PNG as base64; null once pxpipe has evicted it from its in-memory ring. */
    pngBase64: z.string().nullable(),
    sourceText: z.string().nullable(),
    meta: z.string().nullable(),
  }),
});
