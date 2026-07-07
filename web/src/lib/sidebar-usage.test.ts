import { describe, expect, it } from "vitest";
import type { AgentSession, SessionUsage } from "@/api/types";
import {
  agentForModel,
  summarizeSidebarUsage,
  type UsageAgent,
} from "./sidebar-usage";

const NOW = Date.parse("2026-07-07T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function row(model: string, tokens: number, cost: number | null): SessionUsage {
  return {
    session_id: "s",
    model,
    input_tokens: tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: cost,
    updated_at: "",
  };
}

function session(
  id: string,
  updatedMsAgo: number,
  usage: SessionUsage[],
): AgentSession {
  const updated_at = new Date(NOW - updatedMsAgo).toISOString();
  return {
    id,
    agent: "lh-dev",
    session: id,
    created_at: updated_at,
    updated_at,
    usage,
  };
}

function bucket(
  summaries: ReturnType<typeof summarizeSidebarUsage>,
  agent: UsageAgent,
) {
  const s = summaries.find((x) => x.agent === agent);
  if (!s) throw new Error(`missing ${agent}`);
  return s;
}

describe("agentForModel", () => {
  it("classifies Codex model ids", () => {
    expect(agentForModel("gpt-5.4")).toBe("codex");
    expect(agentForModel("gpt-5.3-codex-spark")).toBe("codex");
    expect(agentForModel("codex")).toBe("codex");
  });
  it("classifies Claude model ids", () => {
    expect(agentForModel("claude-opus-4-8")).toBe("claude");
    expect(agentForModel("sonnet-5")).toBe("claude");
    expect(agentForModel("haiku")).toBe("claude");
  });
});

describe("summarizeSidebarUsage", () => {
  it("always returns both agents claude-first", () => {
    const out = summarizeSidebarUsage([], NOW);
    expect(out.map((s) => s.agent)).toEqual(["claude", "codex"]);
  });

  it("marks empty buckets as n/a (no usage)", () => {
    const claude = bucket(summarizeSidebarUsage(undefined, NOW), "claude");
    expect(claude.currentSession.hasUsage).toBe(false);
    expect(claude.currentWeek.hasUsage).toBe(false);
    expect(claude.currentSession.cost).toBeNull();
  });

  it("uses the most recently updated session for current session", () => {
    const sessions: AgentSession[] = [
      session("old", 3 * DAY, [row("opus", 100, 1)]),
      session("new", 1 * DAY, [row("opus", 40, 0.5)]),
    ];
    const claude = bucket(summarizeSidebarUsage(sessions, NOW), "claude");
    expect(claude.currentSession.tokens).toBe(40);
    expect(claude.currentSession.cost).toBe(0.5);
  });

  it("sums current week only within the 7-day window", () => {
    const sessions: AgentSession[] = [
      session("recent", 2 * DAY, [row("opus", 100, 1)]),
      session("edge", 6 * DAY, [row("opus", 10, 0.1)]),
      session("stale", 10 * DAY, [row("opus", 999, 9)]),
    ];
    const claude = bucket(summarizeSidebarUsage(sessions, NOW), "claude");
    expect(claude.currentWeek.tokens).toBe(110);
    expect(claude.currentWeek.cost).toBeCloseTo(1.1);
  });

  it("excludes future-dated sessions from the week window", () => {
    const sessions: AgentSession[] = [
      session("future", -2 * DAY, [row("opus", 77, 0.7)]), // updated_at ahead of now
      session("recent", 1 * DAY, [row("opus", 10, 0.1)]),
    ];
    const claude = bucket(summarizeSidebarUsage(sessions, NOW), "claude");
    expect(claude.currentWeek.tokens).toBe(10);
  });

  it("splits Claude and Codex within the same session by model", () => {
    const sessions: AgentSession[] = [
      session("mix", 1 * DAY, [row("opus", 50, 1), row("gpt-5.4", 20, 0.2)]),
    ];
    const out = summarizeSidebarUsage(sessions, NOW);
    expect(bucket(out, "claude").currentSession.tokens).toBe(50);
    expect(bucket(out, "codex").currentSession.tokens).toBe(20);
  });

  it("reports cost null when any model cost is unknown", () => {
    const sessions: AgentSession[] = [
      session("s", 1 * DAY, [row("opus", 50, 1), row("mystery", 5, null)]),
    ];
    const claude = bucket(summarizeSidebarUsage(sessions, NOW), "claude");
    expect(claude.currentWeek.hasUsage).toBe(true);
    expect(claude.currentWeek.cost).toBeNull();
  });

  it("aggregates all token fields, not just input", () => {
    const usage: SessionUsage = {
      session_id: "s",
      model: "opus",
      input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 4,
      output_tokens: 8,
      cost_usd: 1,
      updated_at: "",
    };
    const claude = bucket(
      summarizeSidebarUsage([session("s", 0, [usage])], NOW),
      "claude",
    );
    expect(claude.currentSession.tokens).toBe(15);
  });
});
