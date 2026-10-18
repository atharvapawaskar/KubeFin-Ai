# KubeFin Worker Helm chart

This chart deploys the asynchronous Worker as a non-root Kubernetes Deployment with a ClusterIP Service, bounded resource requests/limits, health probes, and an existing Secret reference for MongoDB and Redis credentials. It does not create databases, Redis, or application secrets.

## Build the image

From the repository root:

```sh
docker build -f deploy/docker/worker.Dockerfile -t kubefin-worker:local .
```

Push the image to your trusted registry and provide its full repository and immutable tag at install time. The default `kubefin-worker:local` is suitable only for local clusters where that image is loaded into the node runtime; replace it for shared environments.

## Prepare the namespace and credentials

Create the target namespace and a Secret containing `MONGODB_URI` and `REDIS_URL` keys. Configure a least-privilege MongoDB account for the collections and indexes used by the Worker, and Redis credentials scoped to the configured usage stream and dead-letter stream. The chart only reads the existing Secret through `secretKeyRef` and never renders credential values into a manifest.

## Install

```sh
helm lint deploy/helm/worker
helm template kubefin deploy/helm/worker --namespace kubefin \
  --set image.repository=registry.example.com/kubefin/worker \
  --set image.tag=YOUR_IMMUTABLE_TAG
helm upgrade --install kubefin deploy/helm/worker --namespace kubefin --create-namespace \
  --set image.repository=registry.example.com/kubefin/worker \
  --set image.tag=YOUR_IMMUTABLE_TAG
```

The chart's default requests and limits are starting values, not capacity guarantees. Measure memory, CPU, event rates, batch size, and Redis lag under representative traffic before changing replicas or resources. Multiple replicas share the Redis consumer group and each replica receives a unique consumer name from the Worker.

The Service exposes both health/application HTTP and the separate metrics listener inside the cluster. There is no Ingress or public endpoint. Restrict access to the metrics port with cluster network policy and scrape the Service using the annotations documented in [../../prometheus/README.md](../../prometheus/README.md).

## Optional Kubernetes workload discovery

Discovery is disabled by default. To enable it, set `kubernetesDiscovery.enabled=true` and supply the cluster ID and all three label keys from the team's agreed labeling convention. Helm then creates a ServiceAccount, mounts its in-cluster token, and grants a ClusterRole with only `list` and `watch` on Pod metadata across namespaces. Keep discovery off until that convention and the access scope are approved for the target cluster.

## Shutdown and probes

Startup and liveness probe `/healthz`; readiness probes `/readyz`, which requires MongoDB and Redis connectivity. The 45 second termination grace period lets the Worker stop polling and leave unacknowledged stream entries recoverable. Tune it with the actual Redis blocking interval and orchestration shutdown budget.
