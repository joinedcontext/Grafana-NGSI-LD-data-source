# The demo's live feeds (hsl.mjs, fmi.mjs, events.mjs); docker compose builds it once and picks the
# script per service (../docker-compose.yml)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY ngsild.mjs hsl.mjs fmi.mjs events.mjs ./
USER node
CMD ["node", "hsl.mjs"]
