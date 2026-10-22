# Stage 2 Redis Cluster Stream Migration & Rollback Runbook

> [!IMPORTANT]
> **Status:** PROPOSED RUNBOOK — AWAITING M1 & M3 STAGING DRY-RUN APPROVAL
> **Gate Authority:** This runbook defines the operational cutover procedure for Task 3.2B.
> Task 3.2 remains strictly **`[!] BLOCKED`**. Checklist K remains **`BLOCKED`** pending execution of a staging cluster dry-run and recorded operational approval from M1 (Gateway) and M3 (Worker).

---

## 1. Context & Objective

In single-node Redis, the Worker executes `deadLetterAndAckScript` ([`services/worker/src/redis-stream-port.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/worker/src/redis-stream-port.ts#L4-L24)) atomically across `usage-events` and `usage-events:dlq`.
In Redis Cluster:
- `usage-events` maps to hash slot `1745` (`CRC16("usage-events") mod 16384`).
- `usage-events:dlq` maps to hash slot `14521` (`CRC16("usage-events:dlq") mod 16384`).
- Evaluating both keys in a multi-key Lua script causes `CROSSSLOT Keys in request don't hash to the same slot`, terminating event dead-lettering.

### Target Stream Keys
By standardizing on the shared hash tag `{usage-events}`:
- **Primary Stream:** `{usage-events}` $\rightarrow$ slot `1745`.
- **Dead-Letter Stream:** `{usage-events}:dlq` $\rightarrow$ slot `1745`.
- **Consumer Group:** `kubefin-worker-v1`.

Both keys evaluate to the identical hash slot `1745`, guaranteeing atomic multi-key Lua script execution in Redis Cluster without cross-slot errors.

---

## 2. Preflight Verification Checklist

Before initiating cutover, operators must execute and verify the following checks:

1. **Verify Redis Cluster Slot Co-location:**
   ```bash
   redis-cli -c -u "$REDIS_URL" CLUSTER KEYSLOT "{usage-events}"
   # Expected output: 1745

   redis-cli -c -u "$REDIS_URL" CLUSTER KEYSLOT "{usage-events}:dlq"
   # Expected output: 1745
   ```
2. **Verify Legacy Stream Status:**
   ```bash
   redis-cli -c -u "$REDIS_URL" XLEN usage-events
   redis-cli -c -u "$REDIS_URL" XPENDING usage-events kubefin-worker-v1
   ```
3. **Pre-Create Consumer Group on Target Stream:**
   The consumer group on the target stream must be initialized with `MKSTREAM` at ID `0` prior to Gateway publisher redirection:
   ```bash
   redis-cli -c -u "$REDIS_URL" XGROUP CREATE "{usage-events}" kubefin-worker-v1 0 MKSTREAM
   ```
   *(Tolerates `BUSYGROUP Consumer Group name already exists`).*

---

## 3. Migration Cutover Procedure (Zero-Downtime Drain)

The cutover follows a 4-phase safe-drain sequence:

### Phase 1: Deploy Target Consumer Group on Worker
1. Deploy a parallel Worker deployment (e.g. `kubefin-worker-target`) configured with `REDIS_USAGE_STREAM="{usage-events}"` alongside the existing Worker deployment consuming `usage-events`:
   *(Note: Worker `main.ts` configures a single consumer per container process; parallel Worker deployments run concurrently to achieve dual-stream consumption without modifying Worker application code).*
   ```yaml
   env:
     - name: REDIS_USAGE_STREAM
       value: "{usage-events}"
     - name: REDIS_USAGE_GROUP
       value: "kubefin-worker-v1"
   ```
2. Worker verifies stream connection, auto-creates group `kubefin-worker-v1` at ID `'0'` via `MKSTREAM`, and begins polling `{usage-events}`.

### Phase 2: Gateway Publisher Redirection
1. Update Gateway configuration:
   ```yaml
   env:
     - name: REDIS_USAGE_STREAM
       value: "{usage-events}"
   ```
2. Execute rolling restart of Gateway deployment (`kubectl rollout restart deployment/kubefin-gateway`).
3. Verify incoming provider call usage events are successfully published to `{usage-events}`:
   ```bash
   redis-cli -c -u "$REDIS_URL" XLEN "{usage-events}"
   ```

### Phase 3: Drain Legacy Stream
1. Keep legacy Worker consumer active until all in-flight messages in legacy `usage-events` are consumed:
   - Monitor lag: `XPENDING usage-events kubefin-worker-v1` must reach `0`.
   - Monitor consumer idle time: no new entries delivered for $\ge 60$ seconds.
2. Confirm durable ingestion in MongoDB collection `usage_events`:
   - Unique index `_id: eventId` guarantees zero duplicate entries even if messages were processed from both streams during rollout.

### Phase 4: Final Cutover Verification
1. Verify dead-lettering atomicity on target stream in Redis Cluster:
   - Validate that malformed test envelopes published to `{usage-events}` trigger atomic `deadLetterAndAckScript` execution and appear in `{usage-events}:dlq` without `CROSSSLOT` errors.
2. Decommission legacy stream readers once legacy PEL and stream length are fully drained.

---

## 4. Rollback Criteria & Abort Procedure

### Rollback Criteria (Abort Triggers)
Immediately initiate rollback if any of the following occur during Phase 2 or Phase 3:
1. Gateway publisher logs `Redis stream publish attempt failed` with error rate $> 0.1\%$.
2. Worker consumer crashes or reports unhandled Redis Cluster errors.
3. Consumer lag on `{usage-events}` increases continuously for $> 5$ minutes without draining.

### Rollback Steps
1. **Revert Gateway Publisher:**
   Revert Gateway `REDIS_USAGE_STREAM` back to `usage-events` and trigger rolling update:
   ```bash
   kubectl set env deployment/kubefin-gateway REDIS_USAGE_STREAM="usage-events"
   ```
2. **Resume Legacy Worker Consumption:**
   Ensure legacy Worker consumer instance is active and processing `usage-events`.
3. **Drain Target Stream In-Flight Messages:**
   Worker instance configured with `REDIS_USAGE_STREAM="{usage-events}"` must remain running until all events published to `{usage-events}` during the incident are fully persisted to MongoDB and acknowledged (`PEL = 0`).
4. **Post-Mortem Analysis:**
   Inspect Gateway and Worker Prometheus metrics (`gateway_events_published_total`, `worker_stream_consumer_lag_messages`) and container logs.

---

## 5. Operational Ownership & Approval Gate

| Role | Service | Responsible Party | Responsibility |
| :--- | :--- | :--- | :--- |
| **Publisher Cutover** | Gateway | M1 (Vedant Rathod) | Coordinate `REDIS_USAGE_STREAM` environment configuration, rolling rollout, and publish error metrics. |
| **Consumer Drain & DLQ** | Worker | M3 (Atharva Pawaskar) | Pre-create consumer group, monitor PEL drain on legacy stream, and verify cluster DLQ Lua execution. |
| **Database Verification** | Database | Shared (M1 / M3) | Verify MongoDB `usage_events` idempotency (`_id: eventId`) during rollout overlap. |

### Sign-off Checklist for Gate Satisfaction:
- [ ] Staging Redis Cluster preflight verification completed (both keys confirmed in slot 1745).
- [ ] Staging rolling cutover executed with zero event loss.
- [ ] Rollback dry-run verified in staging.
- [ ] Formal sign-off recorded from M1 and M3.

---

## 6. Implementation Verification & Readiness Classification

To prevent conflating planned operational procedures with verified code capabilities, all aspects of this runbook are categorized:

| Runbook Aspect | Verification Category | Source Evidence & Verification Basis |
| :--- | :--- | :--- |
| **Cluster Slot Co-location** | **Mathematically Guaranteed** | CRC16 algorithm: `{usage-events}` and `{usage-events}:dlq` strictly hash substring `"usage-events"`, producing slot `1745`. Multi-node live execution requires staging cluster access. |
| **Consumer Group Auto-Creation** | **Source-Code Verified** | `services/worker/src/redis-stream-port.ts#L32-L39` invokes `xGroupCreate(stream, group, '0', { MKSTREAM: true })` on startup; tolerates `BUSYGROUP`. Unit-tested in `redis-stream-port.test.ts#L10-L21`. |
| **PEL Drain & Redelivery** | **Source-Code Verified** | `services/worker/src/redis-stream-port.ts#L58-L70` recovers pending entries via `xAutoClaim`. Unit-tested in `redis-stream-port.test.ts#L23-L36` and `stream-consumer.test.ts#L112-L121`. |
| **MongoDB Ingestion Idempotency** | **Source-Code Verified** | `services/worker/src/usage-event-store.ts#L52-L64` enforces unique index `_id: eventId`. Duplicate deliveries return `'duplicate'` and trigger clean `XACK`. Unit-tested in `usage-event-store.test.ts#L71-L83` and `process-delivery.test.ts#L28-L47`. |
| **DLQ Script Cluster Atomicity** | **Source-Code Verified** | `deadLetterAndAckScript` evaluates `KEYS[1]` and `KEYS[2]`. Guaranteed non-`CROSSSLOT` when both keys share `{usage-events}`. Unit-tested in `redis-stream-port.test.ts#L49-L77`. |
| **Gateway Publisher Switch** | **Source-Code Verified** | `services/gateway/src/config.ts#L159` binds `REDIS_USAGE_STREAM` dynamically; `services/gateway/src/events/redis-publisher.ts` publishes to configured stream with 3x bounded retry. Unit-tested in `usage-events.test.ts`. |
| **Zero-Downtime Parallel Rollout** | **Operational Assumption** | Assumes Kubernetes cluster has sufficient cluster node capacity to run `kubefin-worker` (legacy) and `kubefin-worker-target` concurrently without resource starvation. |
| **Live Cutover & Rollback Drill** | **Requires Staging Access & M3 Sign-off** | Live execution of `CLUSTER KEYSLOT`, rolling restart, PEL drain timing ($\ge 60$s idle), and abort drill requires access to staging Redis Cluster and coordination with M3. |
