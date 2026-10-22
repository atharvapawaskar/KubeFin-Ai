FROM node:24-alpine AS build

WORKDIR /workspace/services/gateway
COPY services/gateway/package.json services/gateway/package-lock.json ./
RUN npm ci --ignore-scripts
COPY services/gateway/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /workspace/services/gateway/package.json ./package.json
COPY --from=build --chown=node:node /workspace/services/gateway/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/services/gateway/dist ./dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js"]
