FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace apps/api --include-workspace-root
COPY apps/api apps/api
EXPOSE 3001
CMD ["npx", "tsx", "apps/api/src/server.ts"]
