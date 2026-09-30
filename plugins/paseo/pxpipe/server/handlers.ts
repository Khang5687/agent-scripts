import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PxpipeConfig } from "../shared/config";
import type { getPreview, getRecent, getSessions, getStats, RecentRow, SessionRow } from "../shared/rpc";
import { EventLogTotals, resolveLogPath } from "./event-log";
import { getBytes, getJson, getOptionalJson, readNumber, readString } from "./proxy-api";
import type { PxpipeSupervisor } from "./supervisor";

/** Preview PNGs travel inside one RPC message; bigger pages stay in pxpipe's own dashboard. */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
/** pxpipe 0.14.0 ASSUMED_INPUT_USD_PER_MTOK, used while no pxpipe is reachable to report its own. */
const DEFAULT_INPUT_USD_PER_MTOK = 10;

function records(value: unknown, key: string): unknown[] {
  const list = typeof value === "object" && value !== null ? Reflect.get(value, key) : null;
  return Array.isArray(list) ? list : [];
}

export class PxpipeHandlers {
  private readonly log = new EventLogTotals();

  constructor(
    private readonly supervisor: PxpipeSupervisor,
    private readonly config: () => PxpipeConfig | null,
  ) {}

  async stats(): Promise<RpcOutput<typeof getStats>> {
    const [log, proxy] = await Promise.all([
      this.log.read(resolveLogPath(this.config())),
      getJson(this.supervisor.port, "/proxy-stats").catch(() => null),
    ]);
    const pricing = proxy && typeof proxy === "object" ? Reflect.get(proxy, "pricing_assumptions") : null;
    return {
      log,
      pricing: {
        inputPerMtok: readNumber(pricing, "input_per_mtok") ?? DEFAULT_INPUT_USD_PER_MTOK,
        source: readString(pricing, "source") ?? "pxpipe default list price",
      },
    };
  }

  async recent({ limit }: RpcInput<typeof getRecent>): Promise<RpcOutput<typeof getRecent>> {
    const payload = await getJson(this.supervisor.port, "/proxy-recent");
    const rows: RecentRow[] = records(payload, "recent").map((row) => {
      const single = readNumber(row, "img_id");
      const many = records(row, "img_ids").filter((item): item is number => typeof item === "number");
      return {
        // pxpipe stamps recent rows with Date.now() / 1000.
        ts: (readNumber(row, "ts") ?? 0) * 1000,
        model: readString(row, "model"),
        status: readNumber(row, "status") ?? 0,
        compressed: typeof row === "object" && row !== null && Reflect.get(row, "compressed") === true,
        inputTokens: readNumber(row, "input_tokens"),
        outputTokens: readNumber(row, "output_tokens"),
        cacheRead: readNumber(row, "cache_read"),
        cacheCreate: readNumber(row, "cache_create"),
        baselineInput: readNumber(row, "baseline_input"),
        actualInput: readNumber(row, "actual_input"),
        imageIds: many.length > 0 ? many : single !== null ? [single] : [],
      };
    });
    rows.sort((left, right) => right.ts - left.ts);
    return { rows: rows.slice(0, limit) };
  }

  async sessions({ limit }: RpcInput<typeof getSessions>): Promise<RpcOutput<typeof getSessions>> {
    const payload = await getJson(this.supervisor.port, "/api/sessions.json");
    const sessions: SessionRow[] = records(payload, "sessions").map((row) => {
      const claudeCode = typeof row === "object" && row !== null ? Reflect.get(row, "claudeCode") : null;
      return {
        id: readString(row, "id") ?? "",
        project: readString(row, "project"),
        lastSeen: readString(row, "lastSeen") ?? "",
        requestCount: readNumber(row, "requestCount") ?? 0,
        tokensSavedEst: readNumber(row, "tokensSavedEst") ?? 0,
        cacheReadTokens: readNumber(row, "cacheReadTokens") ?? 0,
        preview: readString(claudeCode, "firstUserPreview"),
      };
    });
    sessions.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
    return { sessions: sessions.slice(0, limit) };
  }

  async preview({ imageId }: RpcInput<typeof getPreview>): Promise<RpcOutput<typeof getPreview>> {
    const port = this.supervisor.port;
    const [png, source] = await Promise.all([
      getBytes(port, `/proxy-latest-png?id=${imageId}`),
      getOptionalJson(port, `/api/image-source?id=${imageId}`),
    ]);
    const meta = source && typeof source === "object" ? Reflect.get(source, "meta") : null;
    return {
      imageId,
      pngBase64: png && png.byteLength <= MAX_PREVIEW_BYTES ? Buffer.from(png).toString("base64") : null,
      sourceText: readString(source, "source_text"),
      meta: meta === null || meta === undefined ? null : String(meta),
    };
  }
}
