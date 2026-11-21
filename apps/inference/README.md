# Local inference

The native host runs [worker.ts](src/worker.ts) in a separate process. The worker validates requests with
the [IPC schema](src/protocol.ts) and queues them so only one prompt uses the model at a time.

[LocalInference](src/inference.ts) loads a GGUF file from an absolute path. It keeps one model in memory
and releases each request's session and context after use. Changing the path clears the cached model
before disposing it. A failed replacement can then be retried safely.

The [llama adapter](src/llama-adapter.ts) checks the native module's methods and prompt results.
When an invalid request has a usable ID, the worker returns the validation error with that ID.
A failed reply does not prevent the next queued request from running. Disconnecting the host ends
the worker process.

Run the inference tests from the repository root:

```sh
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test apps/inference/test/*.test.mjs
```

The fixtures cover invalid requests, model changes, queue ordering and cleanup on failure. They run
without downloading or loading a model.
