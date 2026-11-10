# syntax=docker/dockerfile:1.7
#
# Easy Grader 服务端镜像。构建上下文必须是仓库根目录（需要 pnpm workspace、admin/、demo/）：
#
#   docker build -f server/Dockerfile -t stkevintan/easy-grader-server:dev .
#
# 发布用 server/scripts/publish.sh。

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 构建：安装依赖（含原生模块 better-sqlite3）、编译 TS、裁剪出生产依赖 ----------
FROM ${NODE_IMAGE} AS build
# better-sqlite3 通常会下载预编译二进制；下载不到时退回源码编译，需要这些工具
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# 先只拷依赖清单，充分利用层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY extension/package.json extension/
COPY e2e/package.json e2e/
COPY tools/package.json tools/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter easy-grader-server...

COPY server/ server/
RUN pnpm --filter easy-grader-server run build \
 && pnpm --filter easy-grader-server --prod deploy /out \
 && rm -rf /out/src /out/test /out/tsconfig*.json /out/Dockerfile /out/scripts /out/docker-compose.yml /out/.env*

# ---------- 运行 ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/app.db \
    ADMIN_DIR=/app/admin \
    DEMO_DIR=/app/demo \
    PRIVACY_DIR=/app/privacy \
    SERVE_DEMO=false \
    SEED_DEMO_PRESET=false
WORKDIR /app

COPY --from=build --chown=node:node /out/ ./
COPY --chown=node:node admin/ ./admin/
COPY --chown=node:node demo/ ./demo/
COPY --chown=node:node privacy/ ./privacy/

# SQLite 数据库和自动生成的 JWT 密钥都放在 /data，挂卷持久化
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
