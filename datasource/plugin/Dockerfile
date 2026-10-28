# Grafana with this plugin built in. docker compose builds it (../docker-compose.yml); no local Node needed.
ARG GRAFANA_VERSION=12.3.0

FROM node:22-alpine AS build
WORKDIR /src
# .npmrc keeps install scripts off
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# docker build --target dist --output <dir>: only the built plugin (../build.sh)
FROM scratch AS dist
COPY --from=build /src/dist /

FROM grafana/grafana:${GRAFANA_VERSION}
COPY --from=build /src/dist /var/lib/grafana/plugins/ngsild-grafana-datasource
