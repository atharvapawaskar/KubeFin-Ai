FROM node:24-alpine AS build

WORKDIR /workspace/services/worker
COPY services/worker/package.json services/worker/package-lock.json ./
RUN npm ci --ignore-scripts
COPY services/worker/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    METRICS_PORT=9090
WORKDIR /app
COPY --from=build --chown=node:node /workspace/services/worker/package.json ./package.json
COPY --from=build --chown=node:node /workspace/services/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/services/worker/dist/src ./dist/src
COPY --from=build --chown=node:node /workspace/services/worker/scripts ./scripts

USER node
EXPOSE 3000 9090
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/src/main.js"]
