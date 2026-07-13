import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createRepo,
  createWorkflow,
  deleteWorkflow,
  getWorkflowContracts,
  listIssues,
  listLabels,
  listRepos,
  listWorkflows,
  rpc,
  updateWorkflow,
} from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockRpc(result: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0];
  return { url, body: JSON.parse((init as RequestInit).body as string) };
}

describe("rpc", () => {
  it("POSTs a JSON-RPC request to /rpc and returns the result", async () => {
    const fetchMock = mockRpc({ ok: true });
    const data = await rpc<{ ok: boolean }>("repos/list", {
      archived: "active",
    });
    expect(data).toEqual({ ok: true });

    const { url, body } = lastRequest(fetchMock);
    expect(url).toBe("/rpc");
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "repos/list",
      params: { archived: "active" },
    });
    expect(typeof body.id).toBe("number");
  });

  it("throws ApiError carrying the status from error.data on an RPC error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32000,
              message: "Not Found",
              data: { status: 404 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(
      rpc("issues/get", { repo: "me/proj", number: 9 }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Not Found",
    });
  });

  it("maps invalid-params (-32602) to status 422 when no data.status is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "Invalid params" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    await expect(rpc("x/y", {})).rejects.toMatchObject({ status: 422 });
  });

  it("throws ApiError on a transport (non-2xx) failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("", { status: 502, statusText: "Bad Gateway" }),
        ),
    );
    await expect(rpc("repos/list")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });
    expect(new ApiError(404, "x")).toBeInstanceOf(Error);
  });
});

describe("typed methods translate to contract params", () => {
  it("listRepos maps the REST archived flag to the contract enum", async () => {
    const fetchMock = mockRpc([]);
    await listRepos("all");
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "repos/list",
      params: { archived: "all" },
    });
  });

  it("createRepo includes the browser session id for repo.created attribution", async () => {
    const fetchMock = mockRpc({ id: 1 });
    await createRepo("/work/app", "me/app", "session-1");
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "repos/create",
      params: {
        path: "/work/app",
        name: "me/app",
        session_id: "session-1",
      },
    });
  });

  it("workflow helpers call the workflows RPC methods", async () => {
    let fetchMock = mockRpc([]);
    await listWorkflows();
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "workflows/list",
      params: {},
    });

    fetchMock = mockRpc({ execute: "Execute contract" });
    await getWorkflowContracts();
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "workflows/contracts",
      params: {},
    });

    fetchMock = mockRpc({ id: 1 });
    await createWorkflow(
      { name: "standard", execute_prompt: "go" },
      "session-1",
    );
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "workflows/create",
      params: {
        name: "standard",
        execute_prompt: "go",
        session_id: "session-1",
      },
    });

    fetchMock = mockRpc({ ok: true });
    await updateWorkflow(
      "standard",
      { new_name: "standard-v2", verify_prompt: "verify" },
      "session-1",
    );
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "workflows/update",
      params: {
        name: "standard",
        new_name: "standard-v2",
        verify_prompt: "verify",
        session_id: "session-1",
      },
    });

    fetchMock = mockRpc({ ok: true });
    await deleteWorkflow("standard", "session-1");
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "workflows/delete",
      params: { name: "standard", session_id: "session-1" },
    });
  });

  it("listIssues parses the query string into structured params (labels -> array)", async () => {
    const fetchMock = mockRpc([]);
    await listIssues(
      "me",
      "proj",
      "kind=issue&state=open&labels=bug,ui&per_page=20",
    );
    expect(lastRequest(fetchMock).body.params).toEqual({
      repo: "me/proj",
      kind: "issue",
      state: "open",
      labels: ["bug", "ui"],
      perPage: 20,
    });
  });

  it("listLabels maps owner/repo to the labels/list contract", async () => {
    const fetchMock = mockRpc([]);
    await listLabels("me", "proj");
    expect(lastRequest(fetchMock).body).toMatchObject({
      method: "labels/list",
      params: { repo: "me/proj" },
    });
  });
});
