FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gis/package.json packages/gis/package.json
COPY packages/satellite/package.json packages/satellite/package.json
COPY packages/ml/package.json packages/ml/package.json
RUN npm install
COPY packages packages
COPY apps/worker apps/worker
RUN npm run build:packages && npm run build --workspace @pasturevision/worker

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/worker apps/worker
COPY --from=build /app/packages packages
CMD ["node", "--max-old-space-size=1536", "apps/worker/dist/index.js"]
