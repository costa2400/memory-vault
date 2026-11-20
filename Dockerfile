FROM node:22-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
# Build the UI, then drop everything the server does not need at runtime.
RUN yarn build && yarn install --frozen-lockfile --production

FROM oven/bun:1-alpine
RUN apk add --no-cache git unzip
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY server.ts package.json ./
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["bun", "server.ts"]
