// Test helper: a `fetch` mock that speaks JSON-RPC. Every client call is POST /rpc with a
// { method, params } body, so component tests stub fetch with method->handler routing
// instead of REST URL matching.
import { vi } from "vitest";

/** Throw from a handler to produce a JSON-RPC error carrying an HTTP-style status. */
export class RpcFault {
  constructor(
    public status: number,
    public message: string,
  ) {}
}

type Handler = (params: any) => unknown | Promise<unknown>;

// A method whose result is a list needs a list even when a test declares no handler for it: the
// generic `{}` fallback below would break the callers that map over what they get back.
const DEFAULT_RESULTS: Record<string, unknown> = {
  "pullFileViews/list": [],
};

export function mockRpcFetch(handlers: Record<string, Handler>) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body ?? "{}"));
    const send = (obj: unknown) =>
      new Response(JSON.stringify(obj), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const subIssuesHandler =
      method === "pageData/subIssues" && handlers["issues/subIssues"]
        ? async (pageParams: any) => {
            const result = await handlers["issues/subIssues"](pageParams);
            if (!Array.isArray(result)) return result;
            return { issues: result, truncated: false, workflow_runs: [] };
          }
        : undefined;
    const pageDataHandler =
      method === "pageData/issueList" && handlers["issues/list"]
        ? async (pageParams: any) => {
            // One call per page, so a handler that counts its invocations sees what the server does.
            const issues = (await handlers["issues/list"](pageParams)) as {
              linked_pull_requests?: { number: number }[];
            }[];
            return {
              issues,
              repo: handlers["repos/get"]
                ? await handlers["repos/get"](pageParams)
                : { default_branch: "main" },
              workspaces: handlers["workspaces/list"]
                ? await handlers["workspaces/list"](pageParams)
                : [],
              labels:
                pageParams.includeLabels && handlers["labels/list"]
                  ? await handlers["labels/list"](pageParams)
                  : [],
              // #112: the page carries each row's workflow run state. Derive it from the per-PR
              // handler a test already declares so rendering rows does not mean mocking both.
              workflow_runs: handlers["workflowRuns/stateForPull"]
                ? (
                    await Promise.all(
                      issues.flatMap((issue) =>
                        (issue.linked_pull_requests ?? []).map((pull) =>
                          handlers["workflowRuns/stateForPull"]({
                            ...pageParams,
                            number: pull.number,
                          }),
                        ),
                      ),
                    )
                  ).filter(Boolean)
                : [],
            };
          }
        : method === "pageData/issueDetail" && handlers["issues/get"]
          ? async (pageParams: any) => {
              const issue: any = await handlers["issues/get"](pageParams);
              const comments = handlers["comments/list"]
                ? await handlers["comments/list"](pageParams)
                : [];
              return {
                issue: { ...issue, comment_list: comments },
                comments,
                acceptance_criteria: handlers["issues/ac/list"]
                  ? await handlers["issues/ac/list"](pageParams)
                  : (issue.acceptance_criteria ?? []),
              };
            }
          : method === "pageData/pullDetail" && handlers["pulls/get"]
            ? async (pageParams: any) => {
                const pull: any = await handlers["pulls/get"](pageParams);
                const comments = handlers["comments/list"]
                  ? await handlers["comments/list"](pageParams)
                  : [];
                // The page carries the diff feedback it renders itself, which the server derives
                // from the orphaned scope of the same list call (#123).
                const feedback: any = handlers["diffFeedback/list"]
                  ? await handlers["diffFeedback/list"]({
                      ...pageParams,
                      scope: { orphaned: true },
                    })
                  : null;
                const reviews = handlers["reviews/list"]
                  ? await handlers["reviews/list"](pageParams)
                  : [];
                const lineComments = handlers["reviews/listComments"]
                  ? await handlers["reviews/listComments"](pageParams)
                  : [];
                // #145: the backend folds the timeline out of the same lists, so the mock mirrors
                // that assembly (chronological, oldest first) instead of asking each test for it.
                const timeline = [
                  // pull.commits is newest first; feed it oldest first so same-second commits stay
                  // in commit order after the chronological stable sort below.
                  ...[...(pull.commits ?? [])].reverse().map((commit: any) => ({
                    kind: "commit",
                    created_at: commit.date,
                    commit,
                  })),
                  ...reviews.map((review: any) => ({
                    kind: "review",
                    created_at: review.submitted_at,
                    review,
                  })),
                  ...comments.map((comment: any) => ({
                    kind: "comment",
                    created_at: comment.created_at,
                    comment,
                  })),
                  // #2500: GitHub-derived entries have no list RPC of their own — the server reads
                  // them from what the worker already observed — so a test that needs them declares
                  // them under this fixture key instead of through a method handler.
                  ...((handlers["fixture/pullGithubActivity"]
                    ? await handlers["fixture/pullGithubActivity"](pageParams)
                    : []) as any[]),
                ].sort(
                  (a: any, b: any) =>
                    Date.parse(a.created_at) - Date.parse(b.created_at),
                );
                return {
                  pull: { ...pull, comment_list: comments },
                  comments,
                  files: handlers["pulls/files"]
                    ? await handlers["pulls/files"](pageParams)
                    : [],
                  reviews,
                  line_comments: lineComments,
                  timeline,
                  diff_feedback: {
                    comment_counts: feedback?.comment_counts ?? {},
                    orphaned_threads: feedback?.threads ?? [],
                  },
                };
              }
            : undefined;
    const handler = handlers[method] ?? subIssuesHandler ?? pageDataHandler;
    if (!handler)
      return send({
        jsonrpc: "2.0",
        id: 1,
        result: DEFAULT_RESULTS[method] ?? {},
      });
    try {
      const result = await handler(params);
      return send({ jsonrpc: "2.0", id: 1, result });
    } catch (e) {
      if (e instanceof RpcFault) {
        return send({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: e.message,
            data: { status: e.status },
          },
        });
      }
      throw e;
    }
  });
}

/** The JSON-RPC request body for the first stubbed-fetch call to `method`, if any. */
export function rpcCall(
  method: string,
): { method: string; params: any } | undefined {
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  for (const c of fetchMock.mock.calls) {
    const body = JSON.parse(String((c[1] as RequestInit).body));
    if (body.method === method) return body;
  }
  return undefined;
}
