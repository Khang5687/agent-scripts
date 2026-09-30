import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { pxpipeConfig, type PxpipeConfig } from "./shared/config";
import { getPreview, getRecent, getSessions, getStats, getStatus, restartProxy, takeOverProxy } from "./shared/rpc";
import { PxpipeHandlers } from "./server/handlers";
import { PxpipeSupervisor } from "./server/supervisor";

export default function contribute(server: PluginServerContext) {
  const supervisor = new PxpipeSupervisor();
  let config: PxpipeConfig | null = null;
  const handlers = new PxpipeHandlers(supervisor, () => config);

  const settings = server.registerSettings(pxpipeConfig);
  const applySettings = (state: PluginSettingsState<typeof pxpipeConfig.schema>) => {
    if (state.status !== "ready") {
      console.error(`pxpipe settings are invalid: ${state.error}`);
      return;
    }
    config = state.values;
    void supervisor.apply(state.values);
  };
  void settings.read().then(applySettings);
  const unsubscribe = settings.subscribe(applySettings);

  // Route selected providers' Anthropic traffic through pxpipe. Only sessions opened while pxpipe
  // answers are routed, so a stopped proxy never strands a new agent on a dead port.
  server.before("agent.session_open", async ({ request }, { signal }) => {
    if (!config?.enabled || !config.routedProviders.includes(request.provider)) return undefined;
    if (request.env.ANTHROPIC_BASE_URL) return undefined;
    if (!(await supervisor.isHealthy(signal))) {
      console.warn(`pxpipe is not answering; opening ${request.provider} agent ${request.agentId} direct`);
      return undefined;
    }
    return { ...request, env: { ...request.env, ANTHROPIC_BASE_URL: supervisor.baseUrl } };
  });

  server.handle(getStatus, () => supervisor.status());
  server.handle(restartProxy, async () => {
    await supervisor.restart();
    return supervisor.status();
  });
  server.handle(takeOverProxy, async () => {
    await supervisor.takeOver();
    return supervisor.status();
  });
  server.handle(getStats, () => handlers.stats());
  server.handle(getRecent, (input) => handlers.recent(input));
  server.handle(getSessions, (input) => handlers.sessions(input));
  server.handle(getPreview, (input) => handlers.preview(input));

  return async () => {
    unsubscribe();
    await supervisor.shutdown();
  };
}
