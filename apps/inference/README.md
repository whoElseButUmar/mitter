# Isolated local inference

`src/worker.ts` is the child-process entrypoint. It accepts only checked IPC requests from
`src/protocol.ts` and serializes them through `InferenceQueue` in `src/inference.ts`. Shared model
settings use the protocol package's described schema.

`LocalInference` owns the loaded model and disposes per-request sessions and contexts, including on
failure. It requires an existing absolute local GGUF path; it never downloads a model. Changing the
model path retires the previous model before loading the replacement. The model and its path share one
cache slot, cleared before awaiting retirement or replacement so a failed transition cannot reuse a
retired model. Required resource slots are explicitly clearable rather than optional.

`src/llama-adapter.ts` treats the dynamically imported module as `unknown`. It checks native method
capabilities, preserves receivers, and validates prompt results before exposing plain resource
types. Valid IPC requests are parsed once; rejected requests are checked for a usable correlation ID
before returning the original validation error. A failed IPC send does not poison the request queue. Disconnect terminates the isolated
process; host cancellation kills it rather than replaying an interrupted operation.

Run the source tests from the repository root:

```sh
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test apps/inference/test/*.test.mjs
```

The fixtures cover malformed modules/messages, request serialization, model replacement, and
cleanup after construction, inference, or disposal failures, including retries after failed model retirement
or replacement. They require no model installation and
make no network requests.
