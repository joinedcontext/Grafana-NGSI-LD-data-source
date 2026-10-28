# Live HSL vehicles into the demo broker; docker compose builds it (../docker-compose.yml)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY hsl.mjs ./
USER node
CMD ["node", "hsl.mjs"]
