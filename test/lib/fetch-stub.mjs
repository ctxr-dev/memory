// Shared test helper: swap `globalThis.fetch` for a stub for the
// duration of a test body, restore the original even if the body
// throws. Captures every `fetch(url, opts)` call so the test can assert
// on URL / method / body shape without hitting real Dify.
//
// Usage (default response — `{result: "success"}`, status 200):
//   await withFetchStub(async (calls) => {
//     await someBridgeFunction(...);
//     assert.equal(calls[0].method, "PATCH");
//   });
//
// Usage (custom response — e.g. echo back a doc id, or simulate a 404):
//   await withFetchStub(async (calls) => {
//     await someBridgeFunction(...);
//   }, {
//     responseFn: (call) => ({
//       ok: true,
//       status: 200,
//       statusText: "OK",
//       text: async () => JSON.stringify({document: {id: "test-id"}}),
//     }),
//   });
//
// **Not nest-safe.** A runtime assert below catches the case where a
// caller forgets and nests two stubs. Tests run serially by default in
// node:test; `Promise.all` of two `withFetchStub` calls would also
// interleave catastrophically.
//
// **Tests for this helper live in `test/lib-helpers.test.mjs` at the
// test root (NOT in test/lib/), because the test glob in package.json
// is `test/*.test.mjs` and does not recurse into test/lib/.**

const DEFAULT_RESPONSE = () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => '{"result": "success"}',
});

// Sentinel attached to the stub so we can detect re-entry.
const STUB_MARKER = Symbol("withFetchStub.installed");

export async function withFetchStub(fn, { responseFn = DEFAULT_RESPONSE } = {}) {
  if (globalThis.fetch && globalThis.fetch[STUB_MARKER]) {
    throw new Error(
      "withFetchStub: cannot nest. An outer stub is already installed; either drop the inner stub or restructure the test.",
    );
  }
  const calls = [];
  const original = globalThis.fetch;
  const stub = async (url, opts) => {
    // Capture headers in addition to method + body so tests can lock
    // contract-critical request shape (e.g. Bearer auth on the Dify
    // create-by-text endpoint, Content-Type alignment). Headers are
    // copied (not referenced) so test-side mutation of the captured
    // object cannot accidentally influence subsequent calls.
    const headers = opts?.headers ? { ...opts.headers } : {};
    const call = { url: String(url), method: opts?.method, body: opts?.body, headers };
    calls.push(call);
    return responseFn(call);
  };
  stub[STUB_MARKER] = true;
  globalThis.fetch = stub;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}
