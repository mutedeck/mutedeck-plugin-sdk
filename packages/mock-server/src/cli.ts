/**
 * mutedeck-mock-server: run a fake MuteDeck for manual or cross-language testing.
 *
 *   npx mutedeck-mock-server --mode v2 --approve auto
 *   npx mutedeck-mock-server --mode v1
 *   npx mutedeck-mock-server --approve manual     # then type: approve | deny | revoke | status mute=active | control toggle_mute
 */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { MockMuteDeck, type ApproveMode, type ServerMode } from "./index.js";

const HELP = `Usage: mutedeck-mock-server [options]

Options:
  --mode <v2|v1>                 v2 = current MuteDeck, v1 = old MuteDeck (drops hello). Default v2
  --approve <auto|manual|deny>   How approval prompts are answered. Default auto
  --host <address>               Bind address. Default 127.0.0.1
  --ws-port <port>               WebSocket port. Default 3492
  --http-port <port>             HTTP port. Default 3491
  --delay <ms>                   Delay before an automatic decision. Default 500
  --deny-retry-after <seconds>   retry_after sent with denials. Default 600
  --quiet                        Don't log traffic
  -h, --help                     Show this help

Commands on stdin:
  approve [instance_id]          Approve pending prompts
  deny [instance_id]             Deny pending prompts
  revoke [instance_id]           Revoke tokens (closes live sockets)
  status key=value ...           Change and push the meeting status, e.g. status mute=active
  control <action> [k=v ...]     Push a browser control forward, e.g. control toggle_mute
  token <instance_id>            Issue a token for an instance (printed)
  pending | clients              List pending prompts / connections
  quit`;

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "v2" },
    approve: { type: "string", default: "auto" },
    host: { type: "string", default: "127.0.0.1" },
    "ws-port": { type: "string", default: "3492" },
    "http-port": { type: "string", default: "3491" },
    delay: { type: "string", default: "500" },
    "deny-retry-after": { type: "string", default: "600" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!["v1", "v2"].includes(values.mode!) || !["auto", "manual", "deny"].includes(values.approve!)) {
  console.error(HELP);
  process.exit(2);
}

const server = await MockMuteDeck.start({
  mode: values.mode as ServerMode,
  approve: values.approve as ApproveMode,
  host: values.host,
  wsPort: Number(values["ws-port"]),
  httpPort: Number(values["http-port"]),
  decisionDelayMs: Number(values.delay),
  denyRetryAfter: Number(values["deny-retry-after"]),
  log: values.quiet ? undefined : (line) => console.log(line),
});
console.log(`MuteDeck mock (${server.mode}) on ${server.wsUrl} and ${server.httpUrl}. Type "help" for commands.`);

server.on("pending", (instanceId: string, client: { name: string }) => {
  if (server.approveMode === "manual") {
    console.log(`Approval requested by ${client.name} (${instanceId}). Type "approve" or "deny".`);
  }
});

const parsePairs = (parts: string[]) =>
  Object.fromEntries(parts.map((p) => p.split("=", 2) as [string, string]).filter(([k, v]) => k && v !== undefined));

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const [command, ...args] = line.trim().split(/\s+/);
  switch (command) {
    case "approve":
      console.log(`approved ${server.approve(args[0])}`);
      break;
    case "deny":
      console.log(`denied ${server.deny(args[0])}`);
      break;
    case "revoke":
      console.log(`revoked ${server.revoke(args[0] ? { instanceId: args[0] } : {})}`);
      break;
    case "status":
      server.pushStatus(parsePairs(args));
      console.log(JSON.stringify(server.status));
      break;
    case "control":
      if (args[0]) {
        console.log(`forwarded to ${server.pushBrowserControl({ action: args[0], ...parsePairs(args.slice(1)) })}`);
      }
      break;
    case "token":
      if (args[0]) {
        console.log(server.issueToken(args[0]));
      }
      break;
    case "pending":
      console.log(server.pendingInstances.join("\n") || "(none)");
      break;
    case "clients":
      for (const c of server.openConnections) {
        console.log(`#${c.id} ${c.path} v${c.protocol} ${c.hello?.client.name ?? c.v1Identifier ?? c.v1Source ?? "?"} auth=${c.authenticated}`);
      }
      break;
    case "quit":
    case "exit":
      void server.close().then(() => process.exit(0));
      break;
    case "help":
      console.log(HELP);
      break;
    case "":
    case undefined:
      break;
    default:
      console.log(`Unknown command "${command}". Type "help".`);
  }
});

const shutdown = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
