# Redis Streams conventions — Stage 2 proposal

This document proposes the Gateway-to-Worker delivery contract for review. The Gateway and Worker must use the same names and envelope before either implementation is considered integrated.

| Purpose | Name | Convention |
| --- | --- | --- |
| Usage stream | `usage-events` | One stream for the MVP; each entry has one `payload` field containing the UTF-8 JSON usage-event v1 object. |
| Worker group | `kubefin-worker-v1` | Shared consumer group; create with `MKSTREAM` at ID `0` so entries already in the stream are delivered. |
| Dead-letter stream | `usage-events:dlq` | One entry per permanently invalid or exhausted delivery; write the DLQ entry before acknowledging the source entry. |

## Delivery rules

- The Worker acknowledges a source stream entry only after the raw event is durably inserted, recognized as an idempotent duplicate, or its dead-letter record is durably written.
- Use Redis consumer-group pending entries for recovery. Workers reclaim entries that have remained idle for the configured claim interval; successful persistence is idempotent so concurrent redelivery is safe.
- Retry transient Redis or MongoDB failures by leaving the source entry pending. Once the contract's delivery limit is reached, persist a DLQ record before acknowledging the source entry.
- Do not trim the source or DLQ streams in Stage 2. Retention and trimming require an operational decision; trimming before durable processing could lose usage.
- The stream payload must never contain prompts, completions, credentials, or secrets. Logs must not include event payloads or validation values.

## DLQ envelope proposal

Each DLQ stream entry contains `sourceStream`, `sourceEntryId`, `failedAt`, `failureCode`, `attempts`, `payloadBytes`, and `payloadSha256`. Invalid payloads are never copied into the DLQ body; retaining only their size and digest prevents malformed input from smuggling prompts, completions, credentials, or PII into persistent storage. For a valid schema-conforming event that exhausts MongoDB retries, include `payload` only when it is at most 256 KiB so the event can be inspected and replayed safely. `failureCode` is a stable, non-sensitive category; exception messages and validation values are not copied to the DLQ or logs. A Lua script checks that the source entry is still pending, appends the DLQ entry, and acknowledges the source entry atomically so recovery cannot create duplicate DLQ entries after a lost Redis response.
