// Orca only: "Apply" a recommendation by typing the model command into a matching agent.
// Orca has no chat composer API (agents are CLIs in terminals), so this is the Orca
// equivalent of Paseo's 1-click Apply. It runs in two steps: a preview the panel shows
// for confirmation, then the send. It only types into an agent that is idle (waiting or
// done), never one that is working or asking for permission.
import type { OrcaWorkerApi } from "orca/worker";
import type { ApplyRequest, ApplyResult } from "./applyTypes";

export type { ApplyRequest, ApplyResult } from "./applyTypes";

type Host = Pick<OrcaWorkerApi["host"], "call">;

interface AgentSpec {
  /** Orca agent ids that run this provider. */
  kinds: string[];
  name: string;
  /** In-session commands that set the model directly, or null when `/model` is only a picker. */
  inSession: ((id: string, thinking: string | null) => string[]) | null;
  /** How to start a new agent on this model. */
  launch: (id: string, thinking: string | null) => string;
  /** Said after sending, when effort cannot be typed. */
  effortHint?: string;
}

const AGENTS: Record<string, AgentSpec> = {
  claude: {
    kinds: ["claude"],
    name: "Claude Code",
    inSession: (id, t) => [`/model ${id}`, ...(t ? [`/effort ${t}`] : [])],
    launch: (id, t) => `claude --model ${id}${t ? ` --effort ${t}` : ""}`,
  },
  codex: {
    kinds: ["codex"],
    name: "Codex",
    inSession: (id, t) => [`/model ${id}${t ? ` --reasoning=${t}` : ""}`],
    launch: (id, t) => `codex -m ${id}${t ? ` -c model_reasoning_effort=${t}` : ""}`,
  },
  copilot: {
    kinds: ["copilot"],
    name: "Copilot CLI",
    inSession: (id) => [`/model ${id}`],
    launch: (id, t) => `copilot --model=${id}${t ? ` --effort=${t}` : ""}`,
    effortHint: "Copilot sets effort inside the /model picker",
  },
  pi: {
    kinds: ["pi", "omp"],
    name: "Pi",
    inSession: (id) => [`/model ${id}`],
    launch: (id, t) => `pi --model ${id}${t ? `:${t}` : ""}`,
    effortHint: "Pi sets thinking with Shift+Tab",
  },
  grok: {
    kinds: ["grok"],
    name: "Grok Build",
    inSession: (id, t) => [`/model ${id}`, ...(t ? [`/effort ${t}`] : [])],
    launch: (id, t) => `grok --model ${id}${t ? ` --effort ${t}` : ""}`,
  },
  // `/model` is a picker (or unconfirmed) in these agents: Apply shows the launch command.
  kimi: { kinds: ["kimi"], name: "Kimi CLI", inSession: null, launch: (id) => `kimi --model ${id}` },
  opencode: { kinds: ["opencode", "opencode2"], name: "OpenCode", inSession: null, launch: (id) => `opencode -m ${id}` },
  cursor: { kinds: ["cursor"], name: "Cursor agent", inSession: null, launch: (id) => `agent --model ${id}` },
  muse: {
    kinds: ["muse"],
    name: "Muse Code",
    inSession: null,
    launch: (id, t) => `muse --model ${id}${t ? ` --reasoning-effort ${t}` : ""}`,
  },
  antigravity: { kinds: ["antigravity"], name: "Antigravity", inSession: null, launch: (id) => `agy --model ${id}` },
};

const IDLE = new Set(["waiting", "done"]);

type AgentRow = {
  terminalId: string | null;
  title: string | null;
  agent: string | null;
  state: string;
  stateStartedAt: number;
};

/** Model ids reach a terminal, so only plain id characters are allowed. */
const SAFE_TEXT = /^[\w./:=@+-]+$/;

export async function applyRecommendation(host: Host, req: ApplyRequest): Promise<ApplyResult> {
  const spec = AGENTS[req.provider];
  const thinking = req.thinking && SAFE_TEXT.test(req.thinking) ? req.thinking : null;
  if (!SAFE_TEXT.test(req.modelId)) {
    return { status: "failed", message: `Refusing to type an unusual model id: ${req.modelId}`, commands: [] };
  }
  if (!spec) {
    return {
      status: "manual",
      message: `QuotaMax doesn't know how to switch ${req.provider} agents. Select ${req.label} in the agent yourself.`,
      commands: [`/model ${req.modelId}`],
    };
  }
  const launch = spec.launch(req.modelId, thinking);
  if (!spec.inSession) {
    return {
      status: "manual",
      message: `${spec.name} can't switch model by command, so start one on ${req.label}:`,
      commands: [launch],
    };
  }

  let agents: AgentRow[];
  try {
    agents = (await host.call("agents.list")).agents as AgentRow[];
  } catch (err) {
    return {
      status: "failed",
      message: `Couldn't list agents: ${err instanceof Error ? err.message : String(err)}`,
      commands: [launch],
    };
  }
  const matching = agents.filter((a) => a.terminalId && a.agent && spec.kinds.includes(a.agent));
  if (matching.length === 0) {
    return {
      status: "no-agent",
      message: `No ${spec.name} agent in the focused workspace. Start one on ${req.label} with:`,
      commands: [launch],
    };
  }
  const idle = matching
    .filter((a) => IDLE.has(a.state))
    .sort((a, b) => b.stateStartedAt - a.stateStartedAt);
  const commands = spec.inSession(req.modelId, thinking);

  if (!req.confirm) {
    const target = idle[0];
    if (!target) {
      return {
        status: "busy",
        message: `${spec.name} is busy. Apply again when it is waiting for you.`,
        commands,
      };
    }
    return {
      status: "ready",
      message: `Send to ${target.title || spec.name}? Anything half-typed in its prompt would be submitted with it.${spec.effortHint && thinking ? ` (${spec.effortHint}.)` : ""}`,
      commands,
      terminalId: target.terminalId!,
      agentTitle: target.title || spec.name,
    };
  }

  // Confirmed: re-check that this agent is still there and still idle before typing.
  const target = matching.find((a) => a.terminalId === req.terminalId);
  if (!target) {
    return { status: "failed", message: "That agent is gone. Apply again.", commands };
  }
  if (!IDLE.has(target.state)) {
    return { status: "busy", message: `${target.title || spec.name} became busy, so nothing was typed.`, commands };
  }
  try {
    for (const text of commands) {
      const { accepted } = await host.call("terminal.sendText", {
        terminalId: target.terminalId!,
        text,
        enter: true,
      });
      if (!accepted) {
        return { status: "failed", message: `Orca didn't accept "${text}".`, commands };
      }
    }
  } catch (err) {
    return {
      status: "failed",
      message: `Couldn't type into the agent: ${err instanceof Error ? err.message : String(err)}`,
      commands,
    };
  }
  return {
    status: "sent",
    message: `Sent to ${target.title || spec.name}.${spec.effortHint && thinking ? ` ${spec.effortHint}: ${thinking}.` : ""}`,
    commands,
    terminalId: target.terminalId!,
    agentTitle: target.title || spec.name,
  };
}
