# Railway build — Dockerfile (replaces nixpacks.toml, which Railway now ignores)
#
# WHY: newer Railway projects build with Railpack, not Nixpacks, so the
# chromium + libraries listed in nixpacks.toml were never installed. The Canva
# automation then fell back to the bundled Chromium, which died on
# "libnss3.so missing". When a Dockerfile exists Railway ALWAYS uses it, so
# what gets installed no longer depends on which builder Railway picks.
#
# Debian's own `chromium` package brings every library it needs (libnss3,
# libgbm, fonts…) through apt dependencies — no hand-maintained list.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium

# python3/make/g++: only a safety net so better-sqlite3 can compile if its
# prebuilt binary is ever unavailable. Fonts: Canva pages render real text.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# /app is kept on purpose: the Railway volume (DB_PATH=/app/data/store.db)
# is mounted under it, so the database and Canva session stay where they were.
WORKDIR /app

# Dependencies first, so code-only changes rebuild fast (Docker layer cache).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
