FROM oven/bun:1.1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

EXPOSE 3000

# Migrations são aplicadas no start do app (idempotentes) — ver main.ts (ET4).
CMD ["bun", "src/main.ts"]
