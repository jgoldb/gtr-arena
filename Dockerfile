FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY packages/shared/ packages/shared/
COPY packages/client/ packages/client/
COPY packages/server/ packages/server/
COPY tsconfig*.json ./
COPY vite.config.ts ./
RUN npm run build -w packages/shared && npm run build -w packages/client && npm run build -w packages/server

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/packages/server/dist packages/server/dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "packages/server/dist/index.js"]
