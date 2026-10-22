# KubeFin Gateway Helm Chart

This chart deploys the KubeFin AI Gateway as a non-root Kubernetes Deployment with a ClusterIP Service, bounded resource requests/limits, health probes, and an existing Secret reference for provider API keys and Redis credentials. It does not create databases, Redis, or application secrets.

## Build the image

From the repository root:

```sh
docker build -f deploy/docker/gateway.Dockerfile -t kubefin-gateway:local .
```

Push the image to your trusted registry and provide its full repository and immutable tag at install time. The default `kubefin-gateway:local` is suitable for local clusters (e.g. minikube, kind, k3s); replace it for shared environments.

## Prepare the namespace and credentials

Create the target namespace and a Secret containing `API_KEY`, `GEMINI_API_KEY`, and `REDIS_URL` keys:

```sh
kubectl create namespace kubefin
kubectl create secret generic kubefin-gateway-runtime \
  --namespace kubefin \
  --from-literal=API_KEY="your-gateway-client-api-key" \
  --from-literal=GEMINI_API_KEY="your-gemini-api-key" \
  --from-literal=REDIS_URL="redis://kubefin-redis:6379"
```

The chart only reads the existing Secret through `secretKeyRef` and never renders raw credentials into manifests.

## Install

```sh
helm lint deploy/helm/gateway
helm template kubefin deploy/helm/gateway --namespace kubefin \
  --set image.repository=registry.example.com/kubefin/gateway \
  --set image.tag=YOUR_IMMUTABLE_TAG
helm upgrade --install kubefin-gateway deploy/helm/gateway --namespace kubefin --create-namespace \
  --set image.repository=registry.example.com/kubefin/gateway \
  --set image.tag=YOUR_IMMUTABLE_TAG
```

## Probes and Health

- Startup probe checks `/health` with failure threshold 10 (allows initial Node.js boot).
- Liveness and readiness probes check `/health` (public, unauthenticated).
- Prometheus metrics are scraped at `/metrics` on port 3000 using Prometheus annotations.
- Graceful shutdown handles `SIGTERM` within the 30-second termination grace period.
