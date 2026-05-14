import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface TailscaleStatus {
  detected: boolean;
  reason?: string;
  version?: string;
  hostname?: string;
  magicDnsName?: string;
  selfIp?: string;
  serveActive?: boolean;
  funnelActive?: boolean;
  inspectedVia: 'localapi' | 'cli' | 'none';
}

export function getTailscaleServeCommands(port: number, _version?: string): string[] {
  return [
    `tailscale serve --service=svc:mcp-server --https=443 http://localhost:${String(port)}`,
    `# Verify: tailscale serve status`,
    `# MCP accessible at: https://svc-mcp-server.<tailnet>.ts.net/mcp`,
  ];
}

export function getTailscaleFunnelCommands(port: number, _version?: string): string[] {
  return [
    `tailscale funnel --service=svc:mcp-server --https=443 http://localhost:${String(port)}`,
    `# Verify: tailscale funnel status`,
  ];
}

async function tryCli(): Promise<TailscaleStatus | null> {
  try {
    const { stdout } = await execAsync('tailscale status --json', { timeout: 5000 });
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const self = (data.Self ?? {}) as Record<string, unknown>;
    const version = (data.Version as string | undefined) ?? undefined;
    const hostname = (self.HostName as string | undefined) ?? undefined;
    const magicDnsName = ((self.DNSName as string | undefined) ?? '')
      .replace(/\.$/, '') || undefined;
    const selfIp = ((self.TailscaleIPs as string[] | undefined) ?? [])[0] ?? undefined;
    const result: TailscaleStatus = {
      detected: true,
      ...(version !== undefined && { version }),
      ...(hostname !== undefined && { hostname }),
      ...(magicDnsName !== undefined && { magicDnsName }),
      ...(selfIp !== undefined && { selfIp }),
      inspectedVia: 'cli',
    };
    return result;
  } catch {
    return null;
  }
}

export async function detectTailscale(): Promise<TailscaleStatus> {
  const cli = await tryCli();
  if (cli) {
    try {
      const { stdout } = await execAsync('tailscale serve status --json', { timeout: 3000 });
      const serve = JSON.parse(stdout) as Record<string, unknown>;
      const hasMcp = JSON.stringify(serve).includes('/mcp');
      cli.serveActive = hasMcp;
    } catch {
      cli.serveActive = false;
    }
    return cli;
  }

  return {
    detected: false,
    reason: 'tailscale CLI not found or daemon unreachable',
    inspectedVia: 'none',
  };
}
