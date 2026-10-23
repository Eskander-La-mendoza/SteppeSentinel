FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gis/package.json packages/gis/package.json
COPY packages/satellite/package.json packages/satellite/package.json
COPY packages/ml/package.json packages/ml/package.json
RUN npm install
COPY packages packages
COPY apps/backend apps/backend
COPY database database
RUN npm run build:packages && npm run build --workspace @pasturevision/backend

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/apps/backend apps/backend
COPY --from=build /app/packages packages
COPY --from=build /app/database database
EXPOSE 4000
CMD ["sh", "-c", "node apps/backend/dist/scripts/migrate.js && node apps/backend/dist/scripts/seed.js && node apps/backend/dist/index.js"]
