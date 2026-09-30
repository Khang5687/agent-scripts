import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "pxpipe";
const CLI_RELATIVE_PATH = path.join("node_modules", "pxpipe-proxy", "bin", "cli.js");

export interface ResolvedCommand {
  argv: [string, ...string[]];
  /** True when argv[0] is this runtime's executable, which needs ELECTRON_RUN_AS_NODE under Paseo Desktop. */
  usesRuntimeExecutable: boolean;
}

function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  if (configured) return configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured;
  return path.join(os.homedir(), ".paseo");
}

function readManifestId(directory: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(directory, "paseo-plugin.json"), "utf8"));
    const id = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "id") : null;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * The daemon evaluates the plugin bundle from a string, so the bundle cannot locate its own
 * directory. Find this plugin's source directory through the daemon config instead.
 */
function findPluginDirectories(): string[] {
  const configPath = path.join(paseoHome(), "config.json");
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  const plugins = typeof config === "object" && config !== null ? Reflect.get(config, "plugins") : null;
  if (typeof plugins !== "object" || plugins === null) return [];
  const directories: string[] = [];
  for (const entry of Object.values(plugins)) {
    if (typeof entry !== "object" || entry === null) continue;
    const directory = Reflect.get(entry, "path");
    if (typeof directory === "string" && readManifestId(directory) === PLUGIN_ID) {
      directories.push(directory);
    }
  }
  return directories;
}

export function resolveCommand(override: string): ResolvedCommand {
  const parts = override.split(/\s+/).filter(Boolean);
  const [program, ...args] = parts;
  if (program) return { argv: [program, ...args], usesRuntimeExecutable: false };

  for (const directory of findPluginDirectories()) {
    const cli = path.join(directory, CLI_RELATIVE_PATH);
    if (existsSync(cli)) return { argv: [process.execPath, cli], usesRuntimeExecutable: true };
  }
  throw new Error(
    "Cannot find pxpipe-proxy. Run `npm install` in the plugin directory, or set Command under Advanced.",
  );
}
