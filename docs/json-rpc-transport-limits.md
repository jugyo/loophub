# JSON-RPC Transport Limit Design

This note is for maintainers of `lh-web`. It records the memory boundary and the response streaming
decision behind the public limits documented in the root and Web READMEs.

## Limits

| Surface | Limit | Rejection |
| --- | ---: | --- |
| Request body | 1 MiB | HTTP 413 and JSON-RPC `-32002` after draining the stream |
| Batch | 100 elements | HTTP 200 and `-32600 Invalid Request` before dispatch |
| Serialized response | 10 MiB | HTTP 200 and `-32001 Response too large` |

The request reader retains chunks only until the byte limit. It continues draining an oversized
request so the server can return a clean HTTP response without retaining later chunks. The batch guard
runs before `Promise.all`, so none of an oversized batch's handlers are dispatched.

## Response boundary and streaming decision

The bounded serializer walks the JSON-RPC response and retains encoded chunks only up to 10 MiB. It
rejects a single string before encoding when the string's unescaped UTF-8 size already exceeds the
remaining budget. This avoids creating an unbounded serialized string or socket/client response.

The service handler still materializes its result object before the HTTP boundary. Streaming JSON was
not introduced because it would also require changing the SPA's whole-body `Response.json()` client
and the JSON-RPC transport, while leaving the handler result allocation unchanged. Data-heavy methods
may still need domain-specific limits if their result objects become a measured memory problem.
