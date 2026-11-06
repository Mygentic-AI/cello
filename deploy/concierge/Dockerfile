# The CELLO Concierge on one small machine: the cello daemon and the Concierge program, in one container,
# kept running by run.sh. Build from the repo root: docker build -f deploy/concierge/Dockerfile -t cello-concierge .
FROM node:24-slim AS build
# pnpm 10, which this repo is built with. pnpm 12 ignores the build-script allowance in package.json and refuses to install.
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# package.json lets SQLCipher's install script run, and nothing else. cbor-extract's is an optional speed-up that cbor-x does without.
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY concierge ./concierge
COPY deploy/concierge/run.sh ./run.sh
RUN ln -s /app/dist/cli.js /usr/local/bin/cello && chmod +x /app/dist/cli.js /app/run.sh \
  && mkdir /data && chown node:node /data
USER node
# Everything the daemon keeps, its keys and its conversations, lives in this one folder. Mount a volume here.
ENV CELLO_HOME=/data
VOLUME /data
# Run it under an init (docker run --init), so a program that dies is reaped rather than left behind.
CMD ["/app/run.sh"]
