import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTool, toolDefinitions } from "../src/tools.ts";

function webFetch(url: unknown): Promise<string> {
  return executeTool({ type: "tool_use", id: "test", name: "web_fetch", input: { url } });
}

test("web_fetch has a required URL in its definition", () => {
  const tool = toolDefinitions.find((definition) => definition.name === "web_fetch");
  assert.ok(tool);
  assert.deepEqual(tool.input_schema.required, ["url"]);
  assert.ok((tool.input_schema.properties as Record<string, unknown>).url);
});

test("web_fetch converts HTML into readable text", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), "https://example.com/article");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(new Headers(options?.headers).get("user-agent"), "coding-agent-lab/1.0");
    return new Response(
      '<h1>Hello &amp; &#x4E2D;</h1><style>hide this</style><script>run this</script><p>Visible &#39;text&#39;</p>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  });

  const result = await webFetch("https://example.com/article");
  assert.equal(result, "Hello & 中\nVisible 'text'");
  assert.equal(typeof result, "string");
});

test("web_fetch preserves plain text and JSON responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response('{"message":"hello"}\n', { headers: { "Content-Type": "application/json" } })
  );
  assert.equal(await webFetch("https://example.com/data"), '{"message":"hello"}\n');
});

test("web_fetch rejects invalid URLs before requesting them", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called");
  });
  assert.match(await webFetch(undefined), /URL must be a string/);
  assert.match(await webFetch("not a URL"), /invalid URL/);
  assert.match(await webFetch("file:///etc/passwd"), /URL must use HTTP/);
  assert.match(await webFetch("https://user:password@example.com/"), /without credentials/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("web_fetch reports HTTP errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not found", { status: 404 }));
  assert.equal(await webFetch("https://example.com/missing"), "Error fetching web page: HTTP 404");
});

test("web_fetch rejects binary content", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/pdf" } })
  );
  assert.equal(
    await webFetch("https://example.com/file.pdf"),
    "Error fetching web page: unsupported content type application/pdf"
  );
});

test("web_fetch reports request timeouts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  });
  assert.equal(await webFetch("https://example.com/slow"), "Error fetching web page: request timed out");
});

test("web_fetch returns network failures as strings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw "offline"; });
  assert.equal(await webFetch("https://example.com/"), "Error fetching web page: offline");
});

test("web_fetch decodes UTF-8 characters split across chunks", async (t) => {
  const bytes = new TextEncoder().encode("A中B");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2));
      controller.close();
    },
  });
  t.mock.method(globalThis, "fetch", async () =>
    new Response(stream, { headers: { "Content-Type": "text/plain" } })
  );
  assert.equal(await webFetch("https://example.com/text"), "A中B");
});

test("web_fetch limits large responses while reading", async (t) => {
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(new Uint8Array(700000).fill(65));
      else controller.enqueue(new Uint8Array(500000).fill(66));
    },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, "fetch", async () =>
    new Response(stream, { headers: { "Content-Type": "text/plain" } })
  );

  const result = await webFetch("https://example.com/large");
  assert.ok(result.length <= 50000);
  assert.match(result, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
  assert.match(result, /\[Response truncated at 1048576 bytes\]$/);
  assert.equal(cancelled, true);
});
