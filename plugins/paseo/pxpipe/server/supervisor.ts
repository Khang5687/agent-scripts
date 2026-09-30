import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseExtraEnv, type PxpipeConfig } from "../shared/config";
import type { Status } from "../shared/rpc";
import { resolveCommand } from "./command";
import { getJson, postJson, readBoolean, readNumber } from "./proxy-api";

const STATE_DIR = path.join(os.homedir(), ".pxpipe");
/** Records the managed child so a SIGKILLed plugin process cannot leave it holding the port. */
const PID_FILE = path.join(STATE_DIR, "paseo-plugin.pid");
/** Where pxpipe persists dashboard model toggles; kept apart from a standalone pxpipe's config. */
const PXPIPE_CONFIG_FILE = path.join(STATE_DIR, "paseo-plugin-config.json");
/** Session state is rewritten whole by its owner; a second pxpipe sharing the file would drop entries. */
const SESSION_STATE_FILE = path.join(STATE_DIR, "paseo-plugin-session-state.json");
const LOG_TAIL_LINES = 200;
const READY_TIMEOUT_MS = 20_000;
/** The daemon SIGKILLs the plugin 2s after asking it to stop; finish before that. */
const STOP_GRACE_MS = 1_500;
const HEALTH_CACHE_MS = 3_000;
const EXTERNAL_CHECK_MS = 5_000;
const MAX_RESTART_DELAY_MS = 30_000;
const STABLE_RUN_MS = 60_000;

type State = Status["state"];

interface ExternalPxpipe {
  pid: number | null;
  version: string | null;
  command: string | null;
  /** True while routing through it; false when it only blocks the port. */
  adopted: boolean;
}

/** Settings that only take effect when pxpipe starts. */
function launchKey(config: PxpipeConfig): string {
  const { enabled: _enabled, compression: _compression, models: _models, routedProviders: _routed, ...launch } = config;
  return JSON.stringify(launch);
}

function buildEnv(config: PxpipeConfig, usesRuntimeExecutable: boolean): NodeJS.ProcessEnv {
  const extra = parseExtraEnv(config.extraEnv);
  if (!extra.ok) throw new Error(`Extra environment: ${extra.error}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(config.port),
    HOST: "127.0.0.1",
    PXPIPE_CONFIG: PXPIPE_CONFIG_FILE,
    PXPIPE_MODELS: config.models.length > 0 ? config.models.join(",") : "off",
    PXPIPE_RENDER_CACHE_BYTES: String(config.renderCacheMb * 1024 * 1024),
    PXPIPE_MAX_REQUEST_BYTES: String(config.maxRequestMb * 1024 * 1024),
  };
  // pxpipe must reach the real upstream even if the daemon itself was started with a reroute.
  delete env.ANTHROPIC_BASE_URL;
  if (usesRuntimeExecutable) env.ELECTRON_RUN_AS_NODE = "1";
  if (config.anthropicUpstream) env.ANTHROPIC_UPSTREAM = config.anthropicUpstream;
  if (config.openaiUpstream) env.OPENAI_UPSTREAM = config.openaiUpstream;
  if (config.gptHistoryMaxImages > 0) env.PXPIPE_GPT_HISTORY_MAX_IMAGES = String(config.gptHistoryMaxImages);
  env.PXPIPE_SESSION_STATE = config.sessionState ? SESSION_STATE_FILE : "off";
  if (config.captureErrorBodies) env.PXPIPE_DEBUG_CAPTURE_4XX = "1";
  return { ...env, ...extra.env };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Stops a pxpipe child left behind by a previous plugin process that was killed before cleanup. */
async function stopOrphan(): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, "utf8"), 10);
  } catch {
    return;
  }
  rmSync(PID_FILE, { force: true });
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;
  if (!processCommand(pid)?.includes("pxpipe")) return;
  console.log(`Stopping orphaned pxpipe process ${pid}`);
  process.kill(pid, "SIGKILL");
  // Wait for the port to be released so the probe below does not mistake it for an external pxpipe.
  for (let waited = 0; waited < 2_000 && isProcessAlive(pid); waited += 50) await sleep(50);
}

/** Returns pxpipe's uptime when the port answers like a pxpipe dashboard, otherwise null. */
async function probePxpipe(port: number): Promise<{ uptimeSec: number } | null> {
  try {
    const stats = await getJson(port, "/proxy-stats");
    if (readBoolean(stats, "compression_enabled") === null) return null;
    return { uptimeSec: readNumber(stats, "uptime_sec") ?? 0 };
  } catch {
    return null;
  }
}

/** Best-effort identity of the process listening on the port: pid, command, and pxpipe-proxy version. */
function identifyListener(port: number): Omit<ExternalPxpipe, "adopted"> {
  let pid: number | null = null;
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    const parsed = Number.parseInt(output.split("\n")[0] ?? "", 10);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    pid = null;
  }
  const command = pid === null ? null : processCommand(pid);
  // npx and global installs run `<prefix>/node_modules/.bin/pxpipe` or `<prefix>/node_modules/pxpipe-proxy/...`.
  const modules = command?.match(/(\S*\/node_modules)\/(?:\.bin\/pxpipe|pxpipe-proxy\/)/)?.[1];
  let version: string | null = null;
  if (modules) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(modules, "pxpipe-proxy", "package.json"), "utf8"));
      const value = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : null;
      version = typeof value === "string" ? value : null;
    } catch {
      version = null;
    }
  }
  return { pid, version, command };
}

/**
 * Owns the pxpipe this plugin routes through. Starts one, or uses a pxpipe already listening on
 * the configured port when `adoptExisting` is on. An external pxpipe keeps its own launch
 * settings; the plugin only drives its kill switch and model scope.
 */
export class PxpipeSupervisor {
  private child: ChildProcess | null = null;
  private external: ExternalPxpipe | null = null;
  private externalCheck: NodeJS.Timeout | null = null;
  private config: PxpipeConfig | null = null;
  private runningKey: string | null = null;
  private state: State = "stopped";
  private command: string[] = [];
  private startedAt: Date | null = null;
  private lastError: string | null = null;
  private lastHealthyAt = 0;
  private readonly logTail: string[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private stopping = false;
  private queue: Promise<void> = Promise.resolve();

  get port(): number {
    return this.config?.port ?? 47821;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Applies a settings document. Launch settings restart pxpipe; live settings go through its API. */
  apply(config: PxpipeConfig): Promise<void> {
    return this.enqueue(async () => {
      this.config = config;
      if (!config.enabled) {
        await this.stop();
        this.state = "disabled";
        return;
      }
      if ((this.child || this.external) && this.runningKey === launchKey(config)) {
        await this.applyLive(config);
        return;
      }
      await this.stop();
      await this.start(config);
    });
  }

  /** Restarts a plugin-owned pxpipe. An external pxpipe is restarted where it was started. */
  restart(): Promise<void> {
    return this.enqueue(async () => {
      const config = this.config;
      if (!config?.enabled || this.external) return;
      this.restartAttempts = 0;
      await this.stop();
      await this.start(config);
    });
  }

  /**
   * Stops the pxpipe another process started on the port, then starts one this plugin owns so
   * every setting applies. Refuses when the listener is not a pxpipe process.
   */
  takeOver(): Promise<void> {
    return this.enqueue(async () => {
      const config = this.config;
      if (!config?.enabled) throw new Error("Turn on Run pxpipe first.");
      const pid = this.external?.pid ?? identifyListener(config.port).pid;
      if (pid === null) throw new Error(`Cannot find the process listening on port ${config.port}.`);
      if (this.child?.pid === pid) return;
      const command = processCommand(pid);
      if (!command?.includes("pxpipe")) {
        throw new Error(
          `Process ${pid} on port ${config.port} is not pxpipe (${command ?? "unknown"}); not stopping it.`,
        );
      }
      await this.stop();
      this.appendLog(`Stopping the pxpipe started outside Paseo (pid ${pid}) to take over port ${config.port}.`);
      process.kill(pid, "SIGTERM");
      for (let waited = 0; waited < 3_000 && isProcessAlive(pid); waited += 100) await sleep(100);
      if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
      for (let waited = 0; waited < 2_000 && (await probePxpipe(config.port)); waited += 100) await sleep(100);
      await this.start(config);
    });
  }

  shutdown(): Promise<void> {
    this.stopping = true;
    return this.enqueue(() => this.stop());
  }

  /** True when pxpipe answered recently, so a session opened now will not hit a dead port. */
  async isHealthy(signal?: AbortSignal): Promise<boolean> {
    if (this.state !== "running") return false;
    if (Date.now() - this.lastHealthyAt < HEALTH_CACHE_MS) return true;
    try {
      await getJson(this.port, "/proxy-stats", signal);
      this.lastHealthyAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<Status> {
    let compressionEnabled: boolean | null = null;
    if (this.state === "running") {
      try {
        compressionEnabled = readBoolean(await getJson(this.port, "/proxy-stats"), "compression_enabled");
        this.lastHealthyAt = Date.now();
      } catch {
        compressionEnabled = null;
      }
    }
    return {
      state: this.state,
      pid: this.child?.pid ?? this.external?.pid ?? null,
      external: this.external
        ? {
            pid: this.external.pid,
            version: this.external.version,
            command: this.external.command,
            adopted: this.external.adopted,
          }
        : null,
      port: this.port,
      baseUrl: this.baseUrl,
      command: this.command,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastError: this.lastError,
      compressionEnabled,
      logTail: [...this.logTail],
    };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.state === "starting") this.state = "failed";
      console.error("pxpipe supervisor:", this.lastError);
    });
    this.queue = next;
    return next;
  }

  private appendLog(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      this.logTail.push(line);
      console.log(`[pxpipe] ${line}`);
    }
    this.logTail.splice(0, Math.max(0, this.logTail.length - LOG_TAIL_LINES));
  }

  private async applyLive(config: PxpipeConfig): Promise<void> {
    await postJson(config.port, "/api/compression", { enabled: config.compression });
    await postJson(config.port, "/fragments/models", {
      list: config.models.length > 0 ? config.models.join(",") : "off",
    });
  }

  private async start(config: PxpipeConfig): Promise<void> {
    if (this.stopping) return;
    this.clearRestartTimer();
    this.state = "starting";
    this.lastError = null;
    await stopOrphan();

    const existing = await probePxpipe(config.port);
    if (existing) {
      if (!config.adoptExisting) {
        this.external = { ...identifyListener(config.port), adopted: false };
        throw new Error(
          `Port ${config.port} is held by a pxpipe started outside Paseo. Take it over or use another port.`,
        );
      }
      await this.adopt(config, existing.uptimeSec);
      return;
    }

    const resolved = resolveCommand(config.command);
    const env = buildEnv(config, resolved.usesRuntimeExecutable);
    const [program, ...args] = resolved.argv;
    this.command = resolved.argv;
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.runningKey = launchKey(config);
    this.startedAt = new Date();
    child.stdout?.on("data", (chunk: Buffer) => this.appendLog(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.appendLog(chunk.toString("utf8")));

    const exit = Promise.withResolvers<string>();
    child.once("error", (error) => exit.resolve(error.message));
    child.once("exit", (code, signal) => exit.resolve(`pxpipe exited (${signal ?? `code ${code}`})`));
    void exit.promise.then((reason) => this.onExit(child, reason));

    if (child.pid) {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(PID_FILE, String(child.pid));
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (this.child !== child) return;
      try {
        await getJson(config.port, "/proxy-stats");
        ready = true;
      } catch {
        await sleep(250);
      }
    }
    if (this.child !== child) return;
    if (!ready) {
      await this.stop();
      this.state = "failed";
      throw new Error(`pxpipe did not answer on port ${config.port} within ${READY_TIMEOUT_MS / 1000}s`);
    }
    await this.applyLive(config);
    this.state = "running";
    this.lastHealthyAt = Date.now();
  }

  private async adopt(config: PxpipeConfig, uptimeSec: number): Promise<void> {
    const external: ExternalPxpipe = { ...identifyListener(config.port), adopted: true };
    this.external = external;
    this.command = external.command ? [external.command] : [];
    this.runningKey = launchKey(config);
    this.startedAt = new Date(Date.now() - uptimeSec * 1000);
    this.appendLog(
      `Using the pxpipe already on port ${config.port}` +
        `${external.version ? ` (pxpipe-proxy ${external.version})` : ""}` +
        `${external.pid ? `, pid ${external.pid}` : ""}. Launch settings are not applied to it.`,
    );
    await this.applyLive(config);
    this.state = "running";
    this.lastHealthyAt = Date.now();
    this.externalCheck = setInterval(() => void this.checkExternal(), EXTERNAL_CHECK_MS);
  }

  /** Starts a plugin-owned pxpipe once an external one stops answering. */
  private async checkExternal(): Promise<void> {
    if (!this.external || (await probePxpipe(this.port))) {
      if (this.external) this.lastHealthyAt = Date.now();
      return;
    }
    void this.enqueue(async () => {
      const config = this.config;
      if (!this.external || !config?.enabled || (await probePxpipe(config.port))) return;
      this.appendLog(`The pxpipe on port ${config.port} stopped answering; starting one.`);
      await this.stop();
      await this.start(config);
    });
  }

  private onExit(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.runningKey = null;
    rmSync(PID_FILE, { force: true });
    this.state = "failed";
    this.lastError = this.logTail.at(-1) ? `${reason}: ${this.logTail.at(-1)}` : reason;
    const config = this.config;
    if (this.stopping || !config?.enabled) return;

    const ranStably = this.startedAt !== null && Date.now() - this.startedAt.getTime() > STABLE_RUN_MS;
    this.restartAttempts = ranStably ? 1 : this.restartAttempts + 1;
    const delay = Math.min(MAX_RESTART_DELAY_MS, 1_000 * 2 ** (this.restartAttempts - 1));
    console.error(`${this.lastError}; restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.enqueue(async () => {
        if (this.child || this.external || !this.config?.enabled) return;
        await this.start(this.config);
      });
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Stops a plugin-owned pxpipe, or stops using an external one without touching it. */
  private async stop(): Promise<void> {
    this.clearRestartTimer();
    if (this.externalCheck) clearInterval(this.externalCheck);
    this.externalCheck = null;
    const child = this.child;
    const hadExternal = this.external !== null;
    this.child = null;
    this.external = null;
    this.runningKey = null;
    if (hadExternal) this.state = "stopped";
    if (!child) return;
    this.state = "stopped";
    if (child.exitCode === null && child.signalCode === null) {
      const exit = Promise.withResolvers<boolean>();
      child.once("exit", () => exit.resolve(false));
      child.kill("SIGTERM");
      const timedOut = await Promise.race([exit.promise, sleep(STOP_GRACE_MS, true)]);
      if (timedOut) child.kill("SIGKILL");
    }
    rmSync(PID_FILE, { force: true });
  }
}
