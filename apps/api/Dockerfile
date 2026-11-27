# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @pulseboard/api --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build -w @pulseboard/api

FROM node:26-alpine
WORKDIR /repo
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @pulseboard/api && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
