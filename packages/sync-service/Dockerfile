FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/sync-protocol ./packages/sync-protocol
RUN npm ci --ignore-scripts && npm run build:protocol
COPY packages/sync-service ./packages/sync-service
RUN npm ci --ignore-scripts --prefix packages/sync-service && npm run build --prefix packages/sync-service
FROM node:24-bookworm-slim
WORKDIR /app/packages/sync-service
COPY --from=build /app/packages/sync-service ./
COPY --from=build /app/packages/sync-protocol /app/packages/sync-protocol
RUN npm prune --omit=dev --ignore-scripts
USER node
CMD ["node", "dist/index.js"]
