# ── build ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/provider-sdk/package.json packages/provider-sdk/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build -w @cloudcopy/web
RUN npm run build -w @cloudcopy/server

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/provider-sdk/package.json packages/provider-sdk/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @cloudcopy/server --include-workspace-root
COPY --from=build /app/apps/server/dist apps/server/dist
# migrate.ts resolves migrations relative to dist/ (join(__dirname, 'migrations'))
COPY --from=build /app/apps/server/src/db/migrations apps/server/dist/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
