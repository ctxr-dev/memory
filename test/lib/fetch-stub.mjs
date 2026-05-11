// Shared test helper: swap `globalThis.fetch` for a stub for the
// duration of a test body, restore the original even if the body throws.
// Captures every `fetch(url, opts)` call so the test can assert on
// URL / method / body shape without hitting real Dify.
//
// Usage:
//   await withFetchStub(async (calls) => {
//     await someBridgeFunction(...);
//     assert.equal(calls[0].method, "PATCH");
//   });
//
// Not nest-safe (don't call withFetchStub inside another withFetchStub).
export async function withFetchStub(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, body: opts?.body });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => '{"result": "success"}',
    };
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}
