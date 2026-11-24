# Build the phone web app and API together from the parent repository.
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:web

FROM node:24-bookworm-slim AS api
WORKDIR /app
COPY restapi/package.json restapi/package-lock.json ./
RUN npm ci
COPY restapi/tsconfig.json ./
COPY restapi/src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEB_DIRECTORY=/app/public
COPY restapi/package.json restapi/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=api --chown=node:node /app/dist ./dist
COPY --from=web --chown=node:node /app/build-web ./public
COPY --chown=node:node restapi/migrations ./migrations
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
