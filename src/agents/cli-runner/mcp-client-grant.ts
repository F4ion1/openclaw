import {
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";

type CliMcpClientGrantParams = Omit<
  Parameters<typeof mintMcpLoopbackClientGrant>[0],
  "memoryAudience"
>;

/**
 * Mint the run-bound loopback grant for one admitted CLI turn, carrying that turn's
 * host memory audience. Turn cleanup always releases the audience's session leases.
 * A registered live process owns its bearer until removal; otherwise cleanup revokes it.
 */
export async function mintCliMcpClientGrant(
  run: Parameters<typeof resolveCliMcpMemoryAudience>[0],
  agentId: string,
  params: CliMcpClientGrantParams,
): Promise<{
  grant: ReturnType<typeof mintMcpLoopbackClientGrant>;
  retainForProcess: () => void;
  cleanup: () => Promise<void>;
}> {
  const { memoryAudience, release } = await resolveCliMcpMemoryAudience(run, {
    agentId,
    sessionKey: params.context.sessionKey,
  });
  let grant: ReturnType<typeof mintMcpLoopbackClientGrant>;
  try {
    grant = mintMcpLoopbackClientGrant({
      ...params,
      ...(memoryAudience ? { memoryAudience } : {}),
    });
  } catch (error) {
    release();
    throw error;
  }
  let processOwned = false;
  let cleanedUp = false;
  return {
    grant,
    retainForProcess: () => {
      processOwned = true;
    },
    cleanup: async () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      if (!processOwned) {
        revokeMcpLoopbackClientGrant(grant.token);
      }
      release();
    },
  };
}
