import { homedir } from "node:os";
import { join } from "node:path";

/** `$PASEO_HOME` when the daemon exported it to this process, else `~/.paseo`. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.PASEO_HOME?.trim();
  let base = join(home, ".paseo");
  if (configured) {
    if (configured === "~") base = home;
    else if (configured.startsWith("~/")) base = join(home, configured.slice(2));
    else base = configured;
  }
  return join(base, "plugin-data", "paseo-skins");
}
