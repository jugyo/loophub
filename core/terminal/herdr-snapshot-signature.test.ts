import { expect, test } from "vitest";
import type {
  HerdrRepoSessionsWire,
  HerdrSessionsWire,
  UsageTotalsWire,
} from "../serialize.ts";
import { herdrSnapshotSignature } from "./herdr-snapshot-signature.ts";

function usage(overrides: Partial<UsageTotalsWire> = {}): UsageTotalsWire {
  return {
    sessions_with_usage: 1,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    has_unknown_cost: false,
    context_usage_percent: null,
    ...overrides,
  };
}

function repo(
  overrides: Partial<HerdrRepoSessionsWire> = {},
): HerdrRepoSessionsWire {
  return {
    repo: "me/app",
    session_name: "me-app-abc",
    agents: [
      {
        id: "p1",
        name: "dev #1",
        status: "working",
        pull: 12,
        pull_closed: false,
        focusable: true,
      },
    ],
    pull_workspaces: [{ pull: 12, pane_id: "p1", status: "working" }],
    issue_workspaces: [],
    ...overrides,
  };
}

function snapshot(
  repos: HerdrRepoSessionsWire[],
  running_repos = repos.map((r) => r.repo),
): HerdrSessionsWire {
  return { repos, running_repos };
}

test("signature changes when an agent's status changes", () => {
  const working = herdrSnapshotSignature(snapshot([repo()]));
  const idle = herdrSnapshotSignature(
    snapshot([
      repo({
        agents: [
          {
            id: "p1",
            name: "dev #1",
            status: "idle",
            pull: 12,
            pull_closed: false,
            focusable: true,
          },
        ],
      }),
    ]),
  );
  expect(working).not.toBe(idle);
});

test("signature ignores volatile token usage on the session", () => {
  const base = repo({
    agents: [
      {
        id: "p1",
        name: "dev #1",
        status: "working",
        pull: 12,
        pull_closed: false,
        focusable: true,
        session: {
          id: "s1",
          agent: "claude-code",
          runtime: "claude-code",
          kind: "dev",
          usage: usage({
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            cost_usd: 0.01,
          }),
        },
      },
    ],
  });
  const grown = repo({
    agents: [
      {
        id: "p1",
        name: "dev #1",
        status: "working",
        pull: 12,
        pull_closed: false,
        focusable: true,
        session: {
          id: "s1",
          agent: "claude-code",
          runtime: "claude-code",
          kind: "dev",
          usage: usage({
            input_tokens: 5000,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 9000,
            output_tokens: 400,
            total_tokens: 14600,
            cost_usd: 1.23,
          }),
        },
      },
    ],
  });
  expect(herdrSnapshotSignature(snapshot([base]))).toBe(
    herdrSnapshotSignature(snapshot([grown])),
  );
});

test("signature reacts to a different session identity", () => {
  const withSession = (id: string): HerdrRepoSessionsWire =>
    repo({
      agents: [
        {
          id: "p1",
          name: "dev #1",
          status: "working",
          pull: 12,
          pull_closed: false,
          focusable: true,
          session: {
            id,
            agent: "claude-code",
            runtime: "claude-code",
            kind: "dev",
            usage: usage(),
          },
        },
      ],
    });
  expect(herdrSnapshotSignature(snapshot([withSession("s1")]))).not.toBe(
    herdrSnapshotSignature(snapshot([withSession("s2")])),
  );
});

test("signature is order-independent for agents and running_repos", () => {
  const a = {
    id: "p1",
    name: "dev #1",
    status: "working",
    pull: 12,
    pull_closed: false,
    focusable: true,
  };
  const b = {
    id: "p2",
    name: "dev #2",
    status: "idle",
    pull: 13,
    pull_closed: false,
    focusable: true,
  };
  const forward = snapshot([repo({ agents: [a, b] })], ["me/app", "me/other"]);
  const reversed = snapshot([repo({ agents: [b, a] })], ["me/other", "me/app"]);
  expect(herdrSnapshotSignature(forward)).toBe(
    herdrSnapshotSignature(reversed),
  );
});

test("signature reacts to running_repos with no visible agents", () => {
  const one = snapshot([repo()], ["me/app"]);
  const two = snapshot([repo()], ["me/app", "me/idle"]);
  expect(herdrSnapshotSignature(one)).not.toBe(herdrSnapshotSignature(two));
});
