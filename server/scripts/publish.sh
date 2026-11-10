#!/usr/bin/env bash
# 构建 linux/amd64 镜像并推送到 Docker Hub（公开仓库）。
#
#   docker login                       # 首次：用 Docker Hub 账号或 Access Token 登录
#   ./server/scripts/publish.sh        # 推送 <版本> 和 latest 两个 tag
#   ./server/scripts/publish.sh 0.2.0  # 指定版本
#   DRY_RUN=1 ./server/scripts/publish.sh   # 只构建不推送
#
# 版本默认取 server/package.json 的 version。
set -euo pipefail

IMAGE="${IMAGE:-stkevintan/easy-grader-server}"
PLATFORM="${PLATFORM:-linux/amd64}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./server/package.json').version")}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
  echo "版本号格式不对：$VERSION（应为 1.2.3 或 1.2.3-rc.1）" >&2
  exit 1
fi
REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

command -v docker >/dev/null || { echo "未找到 docker" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "需要 docker buildx（Docker Desktop 自带）" >&2; exit 1; }

# 推送前确认已登录，避免构建完才发现推不上去。
# 不能靠 `docker info` 里的 Username：OrbStack 和用 credsStore（如 osxkeychain）存凭据时它不显示。
# docker login 成功后，config.json 的 auths 里一定会有 Docker Hub 的条目（凭据本身可能在钥匙串里）。
docker_hub_logged_in() {
  local cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  [[ -f "$cfg" ]] && grep -Eq '"(https://index\.docker\.io/v1/|index\.docker\.io|docker\.io|registry-1\.docker\.io)"' "$cfg"
}
if [[ -z "${DRY_RUN:-}" ]] && ! docker_hub_logged_in; then
  echo "看起来还没登录 Docker Hub，请先执行 docker login" >&2
  echo "（如果确定已登录，可以用 SKIP_LOGIN_CHECK=1 跳过这项检查）" >&2
  [[ -n "${SKIP_LOGIN_CHECK:-}" ]] || exit 1
fi

TAGS=(-t "$IMAGE:$VERSION")
# 预发布版本（带 -rc 等后缀）不覆盖 latest
[[ "$VERSION" == *-* ]] || TAGS+=(-t "$IMAGE:latest")

OUTPUT=(--push)
if [[ -n "${DRY_RUN:-}" ]]; then
  # 单平台时 --load 可以把镜像放进本地 docker，方便 docker run 试跑
  OUTPUT=(--load)
fi

echo "构建 $IMAGE:$VERSION($PLATFORM, 提交 $REVISION)"
docker buildx build \
  --platform "$PLATFORM" \
  -f server/Dockerfile \
  "${TAGS[@]}" \
  --label "org.opencontainers.image.title=easy-grader-server" \
  --label "org.opencontainers.image.version=$VERSION" \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${OUTPUT[@]}" \
  .

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "已构建到本地：docker run --rm -p 3000:3000 -e ADMIN_PASSWORD=... $IMAGE:$VERSION"
else
  echo "已推送：$IMAGE:$VERSION${TAGS[2]:+ 和 latest}"
  echo "仓库地址：https://hub.docker.com/r/$IMAGE"
fi
