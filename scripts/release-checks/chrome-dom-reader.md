# Offline Chrome DOM-reader regressions

`pnpm verify:chrome` runs `chrome-dom-reader.mjs` against the disposable extension prepared by the existing release check. It injects that extension's packaged `mitter-page.js` into **ISOLATED frame 0** and sends authenticated top-frame messages through the production `PageTransport` class compiled into the source browser fixture.

These checks exercise the actual Chrome DOM and packaged page endpoint. They do not exercise the background task controller or prove that `BridgeRunner` will accept or execute a reply. Runner behavior has separate tests. The standalone fixture's `receiptMatched` and exact-text fields compare the production view with synthetic expectations; `receiptState` and `receiptMatches` come from the production fallback itself.

## Safety and lifetime

- Chrome uses the existing disposable profile, private HOME, blocked proxy, and failed DNS resolution. No authenticated profile or provider account is opened.
- CDP `Fetch` interception is installed at the **Request** stage before navigation. Only the exact `GET https://chatgpt.com/c/reader-fixture` Document in the owned top frame is fulfilled, once, with static offline HTML. Every other request fails; authentication challenges are cancelled. No provider request is continued.
- The source page CSP blocks scripts, connections, forms, objects, and base URLs. The iframe decoy has an empty sandbox, no script permission, and no referrer. Neither the extension manifest nor its existing preview CSP is changed.
- Headless setup uses Chrome's Extensions settings `addHostPermission` API for the extension's already-declared optional `https://chatgpt.com/*` origin. The fixture then activates that optional permission through `chrome.permissions.request`. No other origin or API permission is added.
- Interception has byte, in-flight-request, and total-request limits. The checks have a 30-second scheduling budget; existing CDP command/read deadlines and the release check's two-minute process limit still apply.
- Cleanup restores the digest API, releases pending fixture work, stops only the fixture-owned session, closes the supported-origin target before releasing interception, and removes its pipe listener. The enclosing release check removes the profile and extension copy.

## Scenarios

| Group                       | Coverage                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed generation            | A recognized current user article with its full saved receipt, followed by a roleless Thinking/Structuring article and the supported composer Stop button; also a correlated Copy code/nonce candidate while generating.                                                    |
| Complete response           | Adjacent roleless response with supported Good/Bad response controls, with and without Copy code. Highlight spans must preserve literal CRLF, leading/trailing spaces, tabs, escapes, markup text, and non-BMP characters. Copy alone does not prove a response role.       |
| Known-user barriers         | A later recognized user plus an unknown generating tail; a different latest known user. The latest user ID, all prior user IDs, and history must remain visible.                                                                                                            |
| Rejected receipt/role proof | Conflicting user/assistant metadata, an Edit message control, duplicate disjoint receipts, mismatched hashes, and a body edited while retaining its exchange marker.                                                                                                        |
| Unknown barriers            | Multiple substantive unknown turns, an intervening substantive DIV with no turn metadata, and substantive unknown content after the adjacent response.                                                                                                                      |
| Limits and isolation        | More than 24,000 scanned elements; a full receipt present only in an inaccessible opaque iframe.                                                                                                                                                                            |
| Read-only probe             | Fresh, established, and stopped sessions; no DOM mutation, composer change, button click, Pause installation, or session adoption. Probe does not run receipt fallback.                                                                                                     |
| Assistant progress liveness | Update only the roleless response's reasoning paragraph while digest completion is held. Unchanged known-user bodies, identities, roles, and candidate membership must retain receipt-bound waiting proof.                                                                  |
| Async ownership             | User DOM mutation during a real SHA-256 completion; Stop and replacement-session fencing while inspection awaits that digest. The gate changes scheduling only, not digest bytes.                                                                                           |
| Candidate-set freshness     | While a digest is held, insert an exact duplicate before the current known user, replace an earlier known user's different full body with the current receipt, or insert a later different known user and unknown tail. Check both the held result and the next inspection. |

Each ordinary scenario includes prior recognized user and assistant history. Positive cases require the original current user identity and both task bootstrap turns to survive fallback.

The three candidate-set mutation scenarios start with one current receipt and an adjacent roleless response with supported response controls. For the earlier-user edit, that user's initial complete body already carries the current exchange marker but does not match the saved full-body hash, so the mutation changes an existing candidate's full variants rather than only adding a new candidate. The held read must reject completion: `complete=false`, no assistant text, and `unclassifiedTail=true`, while retaining the current known IDs and history. Changed receipt candidates discard the captured match count (`receiptMatches=0`). A newly inserted, different known user leaves the unchanged earlier receipt count at one, but blocks waiting and completion because the latest user does not match. The next inspection must report two disjoint matches as `ambiguous`, or retain the later known-user barrier. Replacing the earlier user's body with the current receipt keeps both IDs but reduces the distinct bootstrap-text history count to one; an inserted roleless duplicate does not change the known history count.

`digest-assistant-progress` starts with the mixed-generating Thinking/Structuring response and real Stop composer, without completion controls. It changes only the reasoning text node, preserving transcript elements, role metadata, and both full known-user bodies. Unlike a changed receipt candidate, assistant-only progress must retain `waiting_reply`, one receipt match, exact current-user receipt, `busy=true`, no assistant text, and the unknown tail. A SECTION containing several logical turns must not make this unrelated text change invalidate the unique user proof. Button/input effects remain zero.

## Evidence and validation

`dom-reader-contracts.ts` validates the synthetic input plans and concise observations. Retained release evidence contains IDs, counts, diagnoses, equality flags, and an inspection/held/refresh/probe phase, never raw message bodies, source, or HTML. The evidence ceiling is 31: 25 primary scenario results, three candidate-mutation follow-up inspections, and three fresh/established/stopped probe observations. Evidence is recorded before assertions so a regression leaves its observed state in the release log. Mount-expression errors are wrapped before they can expose fixture bodies through the shared CDP evaluator.

Focused tooling tests validate scenario construction, assertion failures, and evidence bounds; they do not execute the real-DOM scenarios. The packaged Chrome check exercises those scenarios.

Focused tooling checks:

```sh
node --test scripts/release-checks/chrome-dom-reader.test.mjs
pnpm --filter @mitter/extension typecheck
pnpm check:scripts
```

After the production reader fix and packaged build are ready:

```sh
pnpm build
pnpm verify:chrome
```

The historical pre-fix baseline was captured in real Chrome using a reduced disposable extension built directly from the production page-entry source. That is source-only runtime evidence, not packaged-release validation. The normal `verify:chrome` path never silently substitutes a source page reader for the packaged file.
