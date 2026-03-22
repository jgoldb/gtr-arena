FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
RUN npm ci
COPY packages/shared/ packages/shared/
COPY packages/client/ packages/client/
COPY tsconfig*.json ./
COPY vite.config.ts ./
RUN npm run build -w packages/shared && npm run build -w packages/client

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
RUN echo 'server { listen 8080; root /usr/share/nginx/html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
