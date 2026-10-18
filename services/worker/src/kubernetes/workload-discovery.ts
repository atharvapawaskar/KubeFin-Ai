import { readFile } from 'node:fs/promises';
import https from 'node:https';
import type { Collection } from 'mongodb';

const PAGE_SIZE = 500;
const MAX_PAGES = 1_000;
const MAX_PODS = 100_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_WATCH_EVENT_BYTES = 1 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class KubernetesResourceVersionExpiredError extends Error {
  constructor() {
    super('Kubernetes watch resource version expired');
    this.name = 'KubernetesResourceVersionExpiredError';
  }
}

export interface KubernetesPod {
  uid: string;
  name: string;
  namespace: string;
  serviceAccountName?: string;
  nodeName?: string;
  labels: Record<string, string>;
  owners: Array<{ kind: string; name: string; uid: string }>;
}

interface KubernetesPodPage {
  items: KubernetesPod[];
  continueToken?: string;
  resourceVersion: string;
}

interface KubernetesWatchUpdate {
  type: 'BOOKMARK' | 'ADDED' | 'MODIFIED' | 'DELETED';
  resourceVersion: string;
  pod?: KubernetesPod;
}

export interface KubernetesPodSource {
  listPods(continuation?: string): Promise<KubernetesPodPage>;
  watchPods(
    resourceVersion: string,
    onUpdate: (update: KubernetesWatchUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface WorkloadIdentityLabelKeys {
  tenant: string;
  team: string;
  workload: string;
}

export interface WorkloadDiscoveryConfig {
  clusterId: string;
  identityLabels: WorkloadIdentityLabelKeys;
}

export interface KubernetesWorkloadRecord {
  _id: string;
  clusterId: string;
  namespace: string;
  podUid: string;
  podName: string;
  serviceAccountName?: string;
  nodeName?: string;
  owners: Array<{ kind: string; name: string; uid: string }>;
  tenantId?: string;
  teamId?: string;
  workloadId?: string;
  active: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface WorkloadCollection {
  createIndex(index: Record<string, 1 | -1>, options?: { name?: string }): Promise<unknown>;
  bulkWrite(operations: Array<{
    updateOne: {
      filter: { _id: string };
      update: {
        $set: Partial<Omit<KubernetesWorkloadRecord, 'firstSeenAt'>>;
        $unset?: Partial<Record<'tenantId' | 'teamId' | 'workloadId', ''>>;
        $setOnInsert: { firstSeenAt: Date };
      };
      upsert: true;
    };
  }>, options?: { ordered?: boolean }): Promise<unknown>;
  updateMany(filter: Record<string, unknown>, update: { $set: Partial<KubernetesWorkloadRecord> }): Promise<unknown>;
}

export class KubernetesWorkloadDiscovery {
  constructor(
    private readonly source: KubernetesPodSource,
    private readonly collection: WorkloadCollection,
    private readonly config: WorkloadDiscoveryConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { clusterId: 1, tenantId: 1, teamId: 1, workloadId: 1 },
      { name: 'workload_identity_lookup' },
    );
    await this.collection.createIndex(
      { clusterId: 1, namespace: 1, podUid: 1 },
      { name: 'workload_pod_identity' },
    );
  }

  async refresh(): Promise<{ count: number; resourceVersion: string }> {
    const observedAt = this.now();
    const { pods, resourceVersion } = await this.readAllPods();
    for (let offset = 0; offset < pods.length; offset += PAGE_SIZE) {
      const batch = pods.slice(offset, offset + PAGE_SIZE);
      await this.collection.bulkWrite(batch.map((pod) => ({
        updateOne: {
          filter: { _id: this.recordId(pod) },
          update: {
            $set: this.toRecord(pod, observedAt),
            ...this.identityFieldsToClear(pod),
            $setOnInsert: { firstSeenAt: observedAt },
          },
          upsert: true as const,
        },
      })), { ordered: false });
    }
    await this.collection.updateMany(
      { clusterId: this.config.clusterId, lastSeenAt: { $lt: observedAt } },
      { $set: { active: false } },
    );
    return { count: pods.length, resourceVersion };
  }

  async watch(resourceVersion: string, signal: AbortSignal): Promise<string> {
    let latestResourceVersion = resourceVersion;
    await this.source.watchPods(resourceVersion, async (update) => {
      if (update.type === 'BOOKMARK') {
        latestResourceVersion = update.resourceVersion;
        return;
      }
      if (!update.pod) throw new Error('Kubernetes watch event did not include a Pod');
      await this.applyWatchPod(update.type, update.pod, this.now());
      latestResourceVersion = update.resourceVersion;
    }, signal);
    return latestResourceVersion;
  }

  private async readAllPods(): Promise<{ pods: KubernetesPod[]; resourceVersion: string }> {
    const pods: KubernetesPod[] = [];
    const seenTokens = new Set<string>();
    let continuation: string | undefined;
    let resourceVersion: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.source.listPods(continuation);
      pods.push(...page.items);
      if (resourceVersion && page.resourceVersion !== resourceVersion) {
        throw new Error('Kubernetes API changed resource version during paginated discovery');
      }
      resourceVersion = page.resourceVersion;
      if (pods.length > MAX_PODS) throw new Error('Kubernetes workload discovery exceeded the configured safety bound');
      continuation = page.continueToken;
      if (!continuation) {
        if (!resourceVersion) throw new Error('Kubernetes API omitted the list resource version');
        return { pods, resourceVersion };
      }
      if (seenTokens.has(continuation)) throw new Error('Kubernetes API returned a repeated continuation token');
      seenTokens.add(continuation);
    }
    throw new Error('Kubernetes workload discovery exceeded the page safety bound');
  }

  private async applyWatchPod(type: 'ADDED' | 'MODIFIED' | 'DELETED', pod: KubernetesPod, observedAt: Date): Promise<void> {
    const _id = this.recordId(pod);
    if (type === 'DELETED') {
      await this.collection.updateMany(
        { _id, clusterId: this.config.clusterId },
        { $set: { active: false, lastSeenAt: observedAt } },
      );
      return;
    }
    const update = {
      $set: this.toRecord(pod, observedAt),
      ...this.identityFieldsToClear(pod),
      $setOnInsert: { firstSeenAt: observedAt },
    };
    await this.collection.bulkWrite([{
      updateOne: { filter: { _id }, update, upsert: true },
    }], { ordered: true });
  }

  private recordId(pod: KubernetesPod): string {
    return `${encodeURIComponent(this.config.clusterId)}/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.uid)}`;
  }

  private toRecord(pod: KubernetesPod, observedAt: Date): Omit<KubernetesWorkloadRecord, 'firstSeenAt'> {
    const tenantId = this.labelValue(pod.labels, this.config.identityLabels.tenant);
    const teamId = this.labelValue(pod.labels, this.config.identityLabels.team);
    const workloadId = this.labelValue(pod.labels, this.config.identityLabels.workload);
    return {
      _id: this.recordId(pod),
      clusterId: this.config.clusterId,
      namespace: pod.namespace,
      podUid: pod.uid,
      podName: pod.name,
      ...(pod.serviceAccountName ? { serviceAccountName: pod.serviceAccountName } : {}),
      ...(pod.nodeName ? { nodeName: pod.nodeName } : {}),
      owners: pod.owners,
      ...(tenantId ? { tenantId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(workloadId ? { workloadId } : {}),
      active: true,
      lastSeenAt: observedAt,
    };
  }

  private labelValue(labels: Record<string, string>, key: string): string | undefined {
    const value = labels[key]?.trim();
    return value && value.length <= 256 ? value : undefined;
  }

  private identityFieldsToClear(pod: KubernetesPod): {
    $unset?: Partial<Record<'tenantId' | 'teamId' | 'workloadId', ''>>;
  } {
    const unset: Partial<Record<'tenantId' | 'teamId' | 'workloadId', ''>> = {};
    if (!this.labelValue(pod.labels, this.config.identityLabels.tenant)) unset.tenantId = '';
    if (!this.labelValue(pod.labels, this.config.identityLabels.team)) unset.teamId = '';
    if (!this.labelValue(pod.labels, this.config.identityLabels.workload)) unset.workloadId = '';
    return Object.keys(unset).length > 0 ? { $unset: unset } : {};
  }
}

export interface KubernetesApiConfig {
  host: string;
  port: number;
  tokenFile: string;
  caFile: string;
}

export class InClusterKubernetesPodSource implements KubernetesPodSource {
  constructor(private readonly config: KubernetesApiConfig) {
    if (!/^[a-zA-Z0-9.:-]+$/.test(config.host)) throw new Error('Invalid Kubernetes API host');
  }

  async listPods(continuation?: string): Promise<KubernetesPodPage> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (continuation) query.set('continue', continuation);
    const path = `/api/v1/pods?${query.toString()}`;
    const [token, ca] = await Promise.all([
      readFile(this.config.tokenFile, 'utf8'),
      readFile(this.config.caFile),
    ]);
    const normalizedToken = token.trim();
    if (!normalizedToken || normalizedToken.length > 32_768) throw new Error('Invalid Kubernetes service account token');
    const body = await requestKubernetesApi(this.config, path, normalizedToken, ca);
    return parsePodPage(body);
  }

  async watchPods(
    resourceVersion: string,
    onUpdate: (update: KubernetesWatchUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const query = new URLSearchParams({
      watch: 'true',
      allowWatchBookmarks: 'true',
      resourceVersion,
      timeoutSeconds: '300',
    });
    const [token, ca] = await Promise.all([
      readFile(this.config.tokenFile, 'utf8'),
      readFile(this.config.caFile),
    ]);
    const normalizedToken = token.trim();
    if (!normalizedToken || normalizedToken.length > 32_768) throw new Error('Invalid Kubernetes service account token');
    const response = await openKubernetesWatch(this.config, `/api/v1/pods?${query.toString()}`, normalizedToken, ca, signal);
    let pending = '';
    for await (const chunk of response) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(pending) > MAX_RESPONSE_BYTES && !pending.includes('\n')) {
        throw new Error('Kubernetes watch event exceeded the safety bound');
      }
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_WATCH_EVENT_BYTES) throw new Error('Kubernetes watch event exceeded the safety bound');
        if (line.trim()) await onUpdate(parseWatchUpdate(JSON.parse(line) as unknown));
        newline = pending.indexOf('\n');
      }
    }
    if (Buffer.byteLength(pending) > MAX_WATCH_EVENT_BYTES) throw new Error('Kubernetes watch event exceeded the safety bound');
    if (pending.trim()) await onUpdate(parseWatchUpdate(JSON.parse(pending) as unknown));
  }
}

function requestKubernetesApi(
  config: KubernetesApiConfig,
  path: string,
  token: string,
  ca: Buffer,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: config.host,
      port: config.port,
      path,
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json',
      },
      ca,
      rejectUnauthorized: true,
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Kubernetes API returned a non-success status'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Kubernetes API response exceeded the safety bound'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new Error('Kubernetes API returned invalid JSON'));
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Kubernetes API request timed out')));
    request.on('error', reject);
    request.end();
  });
}

function openKubernetesWatch(
  config: KubernetesApiConfig,
  path: string,
  token: string,
  ca: Buffer,
  signal: AbortSignal,
): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: config.host,
      port: config.port,
      path,
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json',
      },
      ca,
      rejectUnauthorized: true,
      timeout: 330_000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        if (response.statusCode === 410) {
          reject(new KubernetesResourceVersionExpiredError());
          return;
        }
        reject(new Error('Kubernetes watch returned a non-success status'));
        return;
      }
      response.once('close', () => signal.removeEventListener('abort', onAbort));
      resolve(response);
    });
    const onAbort = (): void => {
      request.destroy(new Error('Kubernetes watch was aborted'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    request.on('timeout', () => request.destroy(new Error('Kubernetes watch timed out')));
    request.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    request.end();
  });
}

function parsePodPage(value: unknown): KubernetesPodPage {
  if (!value || typeof value !== 'object') throw new Error('Kubernetes API returned an invalid pod list');
  const list = value as { metadata?: { continue?: unknown; resourceVersion?: unknown }; items?: unknown };
  if (!Array.isArray(list.items) || typeof list.metadata?.resourceVersion !== 'string' || !list.metadata.resourceVersion) {
    throw new Error('Kubernetes API returned an invalid pod list');
  }
  const continueToken = typeof list.metadata?.continue === 'string' && list.metadata.continue.length > 0
    ? list.metadata.continue
    : undefined;
  const items = list.items.map(parsePod);
  return { items, resourceVersion: list.metadata.resourceVersion, ...(continueToken ? { continueToken } : {}) };
}

function parseWatchUpdate(value: unknown): KubernetesWatchUpdate {
  if (!value || typeof value !== 'object') throw new Error('Kubernetes API returned an invalid watch event');
  const event = value as { type?: unknown; object?: unknown };
  if (event.type === 'ERROR') {
    const status = event.object as { code?: unknown } | undefined;
    if (status?.code === 410) throw new KubernetesResourceVersionExpiredError();
    throw new Error('Kubernetes API returned a watch error');
  }
  const object = event.object as { metadata?: { resourceVersion?: unknown } } | undefined;
  const resourceVersion = object?.metadata?.resourceVersion;
  if (typeof resourceVersion !== 'string' || !resourceVersion) throw new Error('Kubernetes watch event omitted its resource version');
  if (event.type === 'BOOKMARK') return { type: 'BOOKMARK', resourceVersion };
  if (event.type !== 'ADDED' && event.type !== 'MODIFIED' && event.type !== 'DELETED') {
    throw new Error('Kubernetes API returned an unsupported watch event');
  }
  return { type: event.type, resourceVersion, pod: parsePod(event.object) };
}

function parsePod(value: unknown): KubernetesPod {
  if (!value || typeof value !== 'object') throw new Error('Kubernetes API returned an invalid pod record');
  const pod = value as {
    metadata?: { uid?: unknown; name?: unknown; namespace?: unknown; labels?: unknown; ownerReferences?: unknown };
    spec?: { serviceAccountName?: unknown; nodeName?: unknown };
  };
  const metadata = pod.metadata;
  if (
    typeof metadata?.uid !== 'string' || !metadata.uid ||
    typeof metadata.name !== 'string' || !metadata.name ||
    typeof metadata.namespace !== 'string' || !metadata.namespace
  ) throw new Error('Kubernetes API returned a pod without required identity fields');
  const labels: Record<string, string> = {};
  if (metadata.labels && typeof metadata.labels === 'object' && !Array.isArray(metadata.labels)) {
    for (const [key, label] of Object.entries(metadata.labels)) {
      if (typeof label === 'string') labels[key] = label;
    }
  }
  const owners: KubernetesPod['owners'] = [];
  if (Array.isArray(metadata.ownerReferences)) {
    for (const owner of metadata.ownerReferences) {
      if (!owner || typeof owner !== 'object') continue;
      const reference = owner as { kind?: unknown; name?: unknown; uid?: unknown };
      if (
        typeof reference.kind === 'string' && typeof reference.name === 'string' &&
        typeof reference.uid === 'string'
      ) owners.push({ kind: reference.kind, name: reference.name, uid: reference.uid });
    }
  }
  return {
    uid: metadata.uid,
    name: metadata.name,
    namespace: metadata.namespace,
    ...(typeof pod.spec?.serviceAccountName === 'string' ? { serviceAccountName: pod.spec.serviceAccountName } : {}),
    ...(typeof pod.spec?.nodeName === 'string' ? { nodeName: pod.spec.nodeName } : {}),
    labels,
    owners,
  };
}

export function createWorkloadDiscovery(
  source: KubernetesPodSource,
  collection: Collection<KubernetesWorkloadRecord>,
  config: WorkloadDiscoveryConfig,
): KubernetesWorkloadDiscovery {
  return new KubernetesWorkloadDiscovery(source, collection, config);
}
