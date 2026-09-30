import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseExtraEnv, type PxpipeConfig } from "../shared/config";
import type { ModelTotals } from "../shared/rpc";
import {
  CACHE_TTL_SEC,
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
  deriveBaselineWarmth,
  type BaselineWarmthPrev,
} from "../node_modules/pxpipe-proxy/dist/core/baseline.js";
import { readNumber, readString } from "./proxy-api";

const CHUNK_BYTES = 1024 * 1024;
/** pxpipe's DashboardState.SESSION_CAP: sessions whose last prefix size is remembered for warm splits. */
const WARMTH_SESSION_CAP = 50;

export function resolveLogPath(config: PxpipeConfig | null): string {
  const extra = config ? parseExtraEnv(config.extraEnv) : null;
  const configured = extra?.ok ? extra.env.PXPIPE_LOG : undefined;
  return configured || path.join(os.homedir(), ".pxpipe", "events.jsonl");
}

/**
 * Per-model totals folded from pxpipe's events.jsonl (tracker.ts TrackEvent rows).
 * pxpipe's own dashboard replays only the last 50 rows after a restart; folding the whole
 * log keeps savings across restarts. Reads only bytes appended since the previous call and
 * restarts when pxpipe rotates the file.
 */
export class EventLogTotals {
  private path = "";
  private offset = 0;
  private remainder = "";
  private decoder = new TextDecoder();
  private rows = 0;
  private readonly models = new Map<string, ModelTotals>();
  private readonly warmth = new Map<string, BaselineWarmthPrev>();
  private pending: Promise<unknown> = Promise.resolve();

  /** Serialized so overlapping RPCs cannot fold the same bytes twice. */
  read(logPath: string): Promise<{ path: string; rows: number; models: ModelTotals[] }> {
    const run = this.pending.then(() => this.readAppended(logPath));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async readAppended(logPath: string): Promise<{ path: string; rows: number; models: ModelTotals[] }> {
    if (logPath !== this.path) this.reset(logPath);
    let size: number;
    try {
      size = (await stat(logPath)).size;
    } catch {
      this.reset(logPath);
      return this.snapshot();
    }
    if (size < this.offset) this.reset(logPath);
    if (size > this.offset) await this.consume(size);
    return this.snapshot();
  }

  private reset(logPath: string): void {
    this.path = logPath;
    this.offset = 0;
    this.remainder = "";
    this.decoder = new TextDecoder();
    this.rows = 0;
    this.models.clear();
    this.warmth.clear();
  }

  private snapshot(): { path: string; rows: number; models: ModelTotals[] } {
    const models = [...this.models.values()]
      .map((totals) => ({ ...totals }))
      .sort((left, right) => right.requests - left.requests);
    return { path: this.path, rows: this.rows, models };
  }

  private async consume(size: number): Promise<void> {
    const handle = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (this.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - this.offset), this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const lines = (this.remainder + this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })).split(
          "\n",
        );
        this.remainder = lines.pop() ?? "";
        for (const line of lines) this.fold(line);
      }
    } finally {
      await handle.close();
    }
  }

  private fold(line: string): void {
    if (!line.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    this.rows += 1;
    const model = readString(row, "model") ?? "unknown";
    const totals = this.models.get(model) ?? {
      model,
      requests: 0,
      compressed: 0,
      measured: 0,
      baselineTokens: 0,
      actualTokens: 0,
      outputTokens: 0,
      baselineWeighted: 0,
      actualWeighted: 0,
    };
    totals.requests += 1;
    const compressed = typeof row === "object" && row !== null && Reflect.get(row, "compressed") === true;
    if (compressed) totals.compressed += 1;
    totals.outputTokens += readNumber(row, "output_tokens") ?? 0;
    const baseline = readNumber(row, "baseline_tokens");
    const input = readNumber(row, "input_tokens");
    const cacheCreate = readNumber(row, "cache_create_tokens") ?? 0;
    const cacheRead = readNumber(row, "cache_read_tokens") ?? 0;
    // Same basis as `pxpipe stats`: probe-OK rows only, cache reads at face value.
    if (readString(row, "baseline_probe_status") === "ok" && baseline !== null && input !== null) {
      totals.measured += 1;
      totals.baselineTokens += baseline;
      totals.actualTokens += input + cacheCreate + cacheRead;
    }
    this.foldWeighted(row, totals, compressed, cacheCreate, cacheRead);
    this.models.set(model, totals);
  }

  /**
   * Cache-weighted savings for Anthropic rows, mirroring the Anthropic branch of pxpipe
   * 0.14.0 DashboardState.replay() (dist/dashboard.js) with pxpipe's own baseline math.
   * OpenAI and Google rows use other formulas and are left out.
   */
  private foldWeighted(
    row: unknown,
    totals: ModelTotals,
    compressed: boolean,
    cacheCreate: number,
    cacheRead: number,
  ): void {
    const provider = readString(row, "accounting_provider");
    const pathName = readString(row, "path") ?? "";
    if (provider === "openai" || provider === "google" || !pathName.includes("messages")) return;
    const input = readNumber(row, "input_tokens") ?? 0;
    const output = readNumber(row, "output_tokens") ?? 0;
    const create1h = readNumber(row, "cache_create_1h_tokens") ?? 0;
    const create5m = readNumber(row, "cache_create_5m_tokens") ?? undefined;
    const haveUsage = input > 0 || output > 0 || cacheCreate > 0 || cacheRead > 0;
    if (!haveUsage) return;

    const baseline = readNumber(row, "baseline_tokens");
    const cacheable = readNumber(row, "baseline_cacheable_tokens") ?? 0;
    const probeStatus = readString(row, "baseline_probe_status");
    const probeOk = probeStatus === "ok" || (probeStatus === null && baseline !== null && baseline > 0);
    const creditSaving = baseline !== null && baseline > 0 && probeOk && compressed;
    const actual = computeActualInputEffWithCacheTier(input, cacheCreate, cacheRead, create1h, create5m);

    const session = readString(row, "first_user_sha8");
    const prefixSha = readString(row, "system_sha8") ?? undefined;
    const completionSec = Date.parse(readString(row, "ts") ?? "") / 1000;
    const startSec = completionSec - Math.max(0, readNumber(row, "duration_ms") ?? 0) / 1000;
    const previous = session ? this.warmth.get(session) : undefined;
    const { warm, prevCacheable } = deriveBaselineWarmth(
      previous,
      startSec,
      cacheable,
      cacheRead,
      CACHE_TTL_SEC,
      prefixSha,
    );
    const baselineWeighted = creditSaving
      ? computeBaselineInputEffWithCacheTier(
          baseline ?? 0,
          cacheable,
          input,
          cacheCreate,
          cacheRead,
          warm,
          prevCacheable,
          create1h,
          create5m,
        )
      : actual;
    if (session) {
      this.warmth.set(session, {
        ts: completionSec,
        cacheable: cacheable > 0 ? cacheable : (previous?.cacheable ?? 0),
        prefixSha: prefixSha ?? previous?.prefixSha,
      });
      if (this.warmth.size > WARMTH_SESSION_CAP) {
        const oldest = this.warmth.keys().next().value;
        if (oldest !== undefined) this.warmth.delete(oldest);
      }
    }
    totals.baselineWeighted += baselineWeighted;
    totals.actualWeighted += actual;
  }
}
