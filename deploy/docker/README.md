# Worker container

Build from the repository root so Docker can copy the pinned Worker lockfile:

```sh
docker build -f deploy/docker/worker.Dockerfile -t kubefin-worker:local .
```

The image uses Node 24 Alpine, installs locked dependencies with lifecycle scripts disabled, compiles in a build stage, prunes development dependencies, and runs as the unprivileged `node` user. Its only runtime entry point starts the Worker. The MongoDB and Redis URLs are supplied at runtime and are not baked into the image.

`docker-compose.yml` remains the existing local MongoDB/Redis profile. Repository CI enforces that it contains only those two infrastructure services; run the Worker image separately when needed.

For Kubernetes installation and secret keys, see `deploy/helm/worker/README.md`.
