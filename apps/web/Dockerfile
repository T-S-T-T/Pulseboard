# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @pulseboard/web --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @pulseboard/web

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
