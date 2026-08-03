import { db } from "./db.ts";
import { subscribers } from "./domain-event-subscribers.ts";
import type { PullMergeMethod } from "./git.ts";
import { emitEvent } from "./store/events.ts";
import { SOURCE_PAYLOAD_VERSION } from "./workflow/source-events.ts";

export type DomainFact =
  | {
      type: "issue.closed";
      repoId: number;
      actor: string;
      issueId: number;
      issueNumber: number;
      reason: { kind: "manual" } | { kind: "pull_merged"; pullNumber: number };
    }
  | {
      type: "pull.closed";
      repoId: number;
      actor: string;
      pullId: number;
      pullNumber: number;
      linkedIssueId: number | null;
      reason:
        | { kind: "manual" }
        | { kind: "linked_issue_closed"; issueNumber: number }
        | { kind: "merged"; sha: string; method: PullMergeMethod }
        | { kind: "github_merged"; githubNumber: number; mergedAt: string };
    };

export type DomainFactOf<T extends DomainFact["type"]> = Extract<
  DomainFact,
  { type: T }
>;

export type Publish = (fact: DomainFact) => void;

export type SyncSubscriber<T extends DomainFact["type"]> = (
  fact: DomainFactOf<T>,
  context: { publish: Publish },
) => undefined;

export type DomainFactSubscriberMap = {
  [T in DomainFact["type"]]: readonly SyncSubscriber<T>[];
};

type PersistedEvent = { type: string; payload: Record<string, unknown> };
type PersistedEventMap = {
  [T in DomainFact["type"]]: (fact: DomainFactOf<T>) => PersistedEvent;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled domain fact variant: ${JSON.stringify(value)}`);
}

const persistedEventMappings = {
  "issue.closed": (fact) => {
    switch (fact.reason.kind) {
      case "manual":
        return {
          type: "issue.closed",
          payload: {
            number: fact.issueNumber,
            source_payload_version: SOURCE_PAYLOAD_VERSION,
          },
        };
      case "pull_merged":
        return {
          type: "issue.closed",
          payload: {
            number: fact.issueNumber,
            closed_by_pull: fact.reason.pullNumber,
          },
        };
      default:
        return assertNever(fact.reason);
    }
  },
  "pull.closed": (fact) => {
    switch (fact.reason.kind) {
      case "manual":
        return {
          type: "pull_request.updated",
          payload: {
            number: fact.pullNumber,
            source_payload_version: SOURCE_PAYLOAD_VERSION,
          },
        };
      case "linked_issue_closed":
        return {
          type: "pull_request.closed",
          payload: {
            number: fact.pullNumber,
            linked_issue: fact.reason.issueNumber,
            source_payload_version: SOURCE_PAYLOAD_VERSION,
          },
        };
      case "merged":
        return {
          type: "pull_request.merged",
          payload: {
            number: fact.pullNumber,
            sha: fact.reason.sha,
            source_payload_version: SOURCE_PAYLOAD_VERSION,
          },
        };
      case "github_merged":
        return {
          type: "pull_request.merged",
          payload: {
            number: fact.pullNumber,
            github_number: fact.reason.githubNumber,
            github_merged_at: fact.reason.mergedAt,
            source_payload_version: SOURCE_PAYLOAD_VERSION,
          },
        };
      default:
        return assertNever(fact.reason);
    }
  },
} satisfies PersistedEventMap;

export function persistedEventFor(fact: DomainFact): PersistedEvent {
  switch (fact.type) {
    case "issue.closed":
      return persistedEventMappings["issue.closed"](fact);
    case "pull.closed":
      return persistedEventMappings["pull.closed"](fact);
    default:
      return assertNever(fact);
  }
}

export const publish: Publish = (fact) => {
  if (!db.inTransaction) {
    throw new Error("domain facts must be published inside a transaction");
  }

  const event = persistedEventFor(fact);
  emitEvent(fact.repoId, event.type, fact.actor, event.payload);

  const context = { publish };
  switch (fact.type) {
    case "issue.closed":
      for (const subscriber of subscribers["issue.closed"])
        subscriber(fact, context);
      return;
    case "pull.closed":
      for (const subscriber of subscribers["pull.closed"])
        subscriber(fact, context);
      return;
    default:
      return assertNever(fact);
  }
};
