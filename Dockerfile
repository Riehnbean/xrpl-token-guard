FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
# MCP clients and Glama can build the stdio target.
FROM runtime AS stdio
CMD ["node", "dist/stdio.js"]

# Preserve the existing default web/Streamable HTTP image.
FROM runtime AS http
EXPOSE 8787
CMD ["node", "dist/http.js"]
