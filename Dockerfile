FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production EFOOD_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "dist/src/cli.js", "serve"]
