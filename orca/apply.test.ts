// `orca plugin test .` — Apply's agent matching and two-step send, over a fake host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRecommendation } from "./apply";
import type { ApplyRequest } from "./applyTypes";

type Agent = { terminalId: string | null; title: string | null; agent: string | null; state: string; stateStartedAt: number };

function fakeHost(agents: Agent[], accept = true) {
  const sent: { terminalId: string; text: string; enter?: boolean }[] = [];
  return {
    sent,
    call: (async (method: string, params?: unknown) => {
      if (method === "agents.list") return { agents };
      if (method === "terminal.sendText") {
        sent.push(params as { terminalId: string; text: string; enter?: boolean });
        return { accepted: accept };
      }
      throw new Error(`unexpected ${method}`);
    }) as never,
  };
}

const opus: ApplyRequest = {
  provider: "claude",
  modelId: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  thinking: "high",
  confirm: false,
};

test("previews, then types /model and /effort into the idle Claude Code agent", async () => {
  const host = fakeHost([
    { terminalId: "t-old", title: "Old", agent: "claude", state: "done", stateStartedAt: 1 },
    { terminalId: "t-new", title: "Main", agent: "claude", state: "waiting", stateStartedAt: 2 },
    { terminalId: "t-codex", title: "Codex", agent: "codex", state: "waiting", stateStartedAt: 3 },
  ]);
  const preview = await applyRecommendation(host, opus);
  assert.equal(preview.status, "ready");
  assert.equal(preview.terminalId, "t-new"); // the most recently idle matching agent
  assert.deepEqual(preview.commands, ["/model claude-opus-5-5", "/effort high"]);
  assert.equal(host.sent.length, 0, "a preview types nothing");

  const sent = await applyRecommendation(host, { ...opus, confirm: true, terminalId: "t-new" });
  assert.equal(sent.status, "sent");
  assert.deepEqual(
    host.sent.map((s) => [s.terminalId, s.text, s.enter]),
    [
      ["t-new", "/model claude-opus-5-5", true],
      ["t-new", "/effort high", true],
    ]
  );
});

test("never types into a working agent, even after a preview", async () => {
  const host = fakeHost([{ terminalId: "t1", title: "Main", agent: "claude", state: "working", stateStartedAt: 1 }]);
  assert.equal((await applyRecommendation(host, opus)).status, "busy");
  assert.equal((await applyRecommendation(host, { ...opus, confirm: true, terminalId: "t1" })).status, "busy");
  assert.equal(host.sent.length, 0);
});

test("no matching agent: offers the launch command", async () => {
  const r = await applyRecommendation(fakeHost([]), opus);
  assert.equal(r.status, "no-agent");
  assert.deepEqual(r.commands, ["claude --model claude-opus-5-5 --effort high"]);
});

test("Codex takes the effort with /model", async () => {
  const host = fakeHost([{ terminalId: "c", title: "Codex", agent: "codex", state: "done", stateStartedAt: 1 }]);
  const r = await applyRecommendation(host, { provider: "codex", modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol", thinking: "medium", confirm: false });
  assert.deepEqual(r.commands, ["/model gpt-6.2-sol --reasoning=medium"]);
});

test("agents whose /model is only a picker get a launch command, not keystrokes", async () => {
  const host = fakeHost([{ terminalId: "k", title: "Kimi", agent: "kimi", state: "waiting", stateStartedAt: 1 }]);
  const r = await applyRecommendation(host, { provider: "kimi", modelId: "k3.1-pro", label: "Kimi K3.1 Pro", thinking: "high", confirm: true, terminalId: "k" });
  assert.equal(r.status, "manual");
  assert.deepEqual(r.commands, ["kimi --model k3.1-pro"]);
  assert.equal(host.sent.length, 0);
});

test("refuses model ids that could carry shell or terminal control text", async () => {
  const host = fakeHost([{ terminalId: "t", title: "Main", agent: "claude", state: "waiting", stateStartedAt: 1 }]);
  const r = await applyRecommendation(host, { ...opus, modelId: "x; rm -rf ~", confirm: true, terminalId: "t" });
  assert.equal(r.status, "failed");
  assert.equal(host.sent.length, 0);
});
