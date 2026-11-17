#!/usr/bin/env bash
# 在服务器上发布 easy-grader：备份数据库 → 拉镜像 → 重建容器 → 查健康，失败自动回滚。
#
#   sudo ./server/scripts/deploy.sh            # 发布（拉 latest，重建，健康检查）
#   sudo ./server/scripts/deploy.sh check      # 只看现状：镜像、容器、健康、env 是否真的进了容器
#   sudo ./server/scripts/deploy.sh backup     # 只备份数据库，服务最后照常运行
#   sudo ./server/scripts/deploy.sh rollback   # 回到上一次发布前的镜像
#
# 为什么要有这个脚本：`docker compose restart` 不会重读 env_file，改了 .env 却只重启的话，
# 容器里还是旧值（线上就踩过：MODEL_API_KEY 一直没进容器）。这里统一用 up -d --force-recreate，
# 并且发布后逐项核对，配置没生效会直接报出来。
#
# 可用环境变量覆盖（一般不用改）：APP_DIR、SERVICE、HEALTH_URL、VOLUME、ENV_FILE、KEEP_BACKUPS。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/1panel/docker/compose/easy-grader}"
SERVICE="${SERVICE:-easy-grader-server-1}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
ENV_FILE="${ENV_FILE:-$APP_DIR/1panel.env}"
VOLUME="${VOLUME:-easy-grader_easy-grader-data}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
STATE_DIR="${STATE_DIR:-/var/lib/easy-grader-deploy}"
LOG_FILE="${LOG_FILE:-/var/log/easy-grader-deploy.log}"
COMPOSE=(docker compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml")

ts() { date +%Y%m%d-%H%M%S; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "错误：$*"; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "需要 root，请用 sudo 运行"
command -v docker >/dev/null || die "找不到 docker"
[[ -f "$APP_DIR/docker-compose.yml" ]] || die "找不到 $APP_DIR/docker-compose.yml"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"
# 同时只允许一个发布在跑
exec 9>/var/lock/easy-grader-deploy.lock
flock -n 9 || die "另一个发布正在进行，稍后再试"
# 输出同时进日志
exec > >(tee -a "$LOG_FILE") 2>&1

container() { docker ps -q -f "name=^${SERVICE}$"; }

# 因为备份停过容器：除了正在发布的路径，任何退出都要把服务恢复运行
SERVICE_STOPPED=0
cleanup() {
  local code=$?
  if ((code != 0)) && [[ $SERVICE_STOPPED -eq 1 ]] && [[ -z "$(container)" ]]; then
    log "出错了，先把容器恢复运行"
    "${COMPOSE[@]}" up -d || log "恢复容器失败，请人工检查"
  fi
}
trap cleanup EXIT

health_json() { curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true; }

health_field() { health_json | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

wait_healthy() {
  local i
  for ((i = 0; i < HEALTH_TIMEOUT / 2; i++)); do
    if [[ "$(health_json)" == *'"ok":true'* ]]; then return 0; fi
    sleep 2
  done
  return 1
}

# env 文件里的变量是否真的进了容器（键和值都比）：restart 不生效时这里会露出来。
# 只打印变量名，不打印任何值。
env_drift() {
  [[ -f "$ENV_FILE" ]] || { echo "找不到 env 文件 $ENV_FILE"; return 0; }
  local in_container key want got
  in_container="$(docker exec "$SERVICE" printenv 2>/dev/null | tr -d '\r' || true)"
  [[ -n "$in_container" ]] || { echo "容器没在运行，无法比对"; return 0; }
  local missing=() differ=() overridden=()
  # compose 文件里 environment: 显式覆盖的值（HOST、DB_PATH 这类）不算漂移
  local compose_keys
  compose_keys=$(sed -n '/^[[:space:]]*environment:/,/^[[:space:]]*[a-z]/p' "$APP_DIR/docker-compose.yml" 2>/dev/null \
    | grep -oE '^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*:' | tr -d ' :' | sort -u)
  for key in $compose_keys; do
    grep -qE "^${key}=" "$ENV_FILE" && overridden+=("$key")
  done
  while IFS= read -r line; do
    key="${line%%=*}"
    [[ " ${overridden[*]:-} " == *" $key "* ]] && continue
    want="${line#*=}"
    # compose 会去掉环境变量值外面的引号
    want="${want%\"}"; want="${want#\"}"; want="${want%\'}"; want="${want#\'}"
    got="$(grep -m1 "^${key}=" <<<"$in_container" || true)"
    if [[ -z "$got" ]]; then missing+=("$key"); continue; fi
    [[ "${got#*=}" != "$want" ]] && differ+=("$key")
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | tr -d '\r')
  if ((${#missing[@]})); then echo "这些变量在 $ENV_FILE 里，但容器里没有：${missing[*]}"; fi
  if ((${#differ[@]})); then echo "这些变量的值和 $ENV_FILE 不一致：${differ[*]}"; fi
  if ((${#overridden[@]})); then echo "由 compose 覆盖、不参与比对：${overridden[*]}"; fi
  if ((${#missing[@]} == 0 && ${#differ[@]} == 0)); then
    echo "env 已全部生效（键和值都一致）"
  fi
}

# restart_when_done=1 时（backup 命令）备份完把服务起回来，发布则由调用方重建
backup_db() {
  local restart_when_done="${1:-0}"
  local dir="$APP_DIR/backups/$(ts)"
  local data="/var/lib/docker/volumes/${VOLUME}/_data"
  local was_running=0
  [[ -n "$(container)" ]] && was_running=1
  log "停止容器，准备备份数据库"
  "${COMPOSE[@]}" stop
  [[ $was_running -eq 1 ]] && SERVICE_STOPPED=1
  mkdir -p "$dir"
  # 数据目录只有 root 能进，通配符必须交给 root 的 shell 展开
  if ! sh -c "cp -a '$data'/app.db* '$dir'/ 2>/dev/null"; then
    die "备份失败：$data 下没有 app.db"
  fi
  local src_sum dst_sum
  src_sum="$(sha256sum "$data/app.db" | cut -d' ' -f1)"
  dst_sum="$(sha256sum "$dir/app.db" | cut -d' ' -f1)"
  [[ "$src_sum" == "$dst_sum" ]] || die "备份校验失败：sha256 不一致（$dir）"
  if command -v sqlite3 >/dev/null; then
    local ic
    ic="$(sqlite3 "$dir/app.db" 'pragma integrity_check;' 2>&1 | head -1)"
    [[ "$ic" == "ok" ]] || die "备份的数据库 integrity_check 不是 ok：$ic"
    log "备份完整：$dir（sha256 一致，integrity_check ok）"
  else
    log "备份完整：$dir（sha256 一致；服务器上没有 sqlite3，跳过 integrity_check）"
  fi
  backup_db_dir="$dir"
  if [[ "$restart_when_done" == "1" ]]; then
    log "备份完成，把服务起回来"
    "${COMPOSE[@]}" up -d
    SERVICE_STOPPED=0
    wait_healthy || log "注意：服务起来了但健康检查还没通过"
  fi
}

prune_backups() {
  local dirs
  mapfile -t dirs < <(find "$APP_DIR/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort)
  local extra=$(( ${#dirs[@]} - KEEP_BACKUPS ))
  if ((extra > 0)); then
    local d
    for d in "${dirs[@]:0:extra}"; do rm -rf "$d" && log "删除旧备份 $d"; done
  fi
}

save_state() {
  cat > "$STATE_DIR/last-deploy.env" <<EOF
AT=$(date -Is)
PREV_IMAGE=$1
PREV_REF=$2
NEW_IMAGE=$3
VERSION=$4
BACKUP=${backup_db_dir:-}
EOF
}

# 回到指定镜像：把镜像重新打回 compose 用的那个引用，再重建
rollback_to() {
  local image="$1" ref="$2"
  [[ -n "$image" ]] || { log "没有可回滚的镜像，需要人工介入"; return 1; }
  log "回滚到发布前的镜像（$ref）"
  docker tag "$image" "$ref"
  SERVICE_STOPPED=1
  "${COMPOSE[@]}" up -d --force-recreate || return 1
  SERVICE_STOPPED=0
  wait_healthy
}

do_check() {
  log "compose 目录：$APP_DIR"
  if [[ -z "$(container)" ]]; then
    log "容器 $SERVICE 没在运行"
  else
    docker ps --filter "name=^${SERVICE}$" --format '容器：{{.Names}}  {{.Status}}'
    docker inspect "$SERVICE" --format '镜像：{{.Config.Image}}  启动于 {{.State.StartedAt}}  重启次数 {{.RestartCount}}' || true
    docker inspect "$SERVICE" --format '镜像 ID：{{.Image}}' || true
  fi
  log "健康检查：$(health_json)"
  local model; model="$(health_field model)"
  if [[ "$model" == "mock" ]]; then
    log "注意：health 里 model 是 mock，说明容器没读到 MODEL_API_KEY，评分会是假的"
  fi
  env_drift
  log "本地镜像："; docker images stkevintan/easy-grader-server --format '  {{.Repository}}:{{.Tag}}  {{.ID}}  {{.CreatedSince}}' 2>/dev/null | head -5 || true
  log "备份：$(find "$APP_DIR/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l) 份，最近一份 $(find "$APP_DIR/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)"
}

do_deploy() {
  local prev_image prev_ref prev_version new_image new_version
  prev_image="$(docker inspect "$SERVICE" --format '{{.Image}}' 2>/dev/null || true)"
  # 记下 compose 实际用的镜像引用（可能是 latest，也可能是 GHCR / 版本 tag），回滚要用它
  prev_ref="$(docker inspect "$SERVICE" --format '{{.Config.Image}}' 2>/dev/null || echo stkevintan/easy-grader-server:latest)"
  prev_version="$(health_field version)"
  log "当前版本：${prev_version:-未知}（镜像 ${prev_image:-无}）"

  # 先拉镜像：拉不动就不动线上
  log "拉取镜像"
  "${COMPOSE[@]}" pull

  backup_db 0
  prune_backups

  log "重建容器（--force-recreate，保证 env 重新读取）"
  if ! "${COMPOSE[@]}" up -d --force-recreate; then
    log "重建失败，回滚"
    rollback_to "$prev_image" "$prev_ref" || log "回滚也失败了，需要人工介入（数据库备份在 ${backup_db_dir:-无}）"
    exit 1
  fi
  SERVICE_STOPPED=0

  if ! wait_healthy; then
    log "新版本没通过健康检查，回滚到 ${prev_version:-上一个镜像}"
    if rollback_to "$prev_image" "$prev_ref"; then
      log "已回滚，线上恢复到 ${prev_version:-上一个镜像}"
    else
      log "回滚后仍不健康，需要人工介入（数据库备份在 ${backup_db_dir:-无}）"
    fi
    exit 1
  fi

  new_image="$(docker inspect "$SERVICE" --format '{{.Image}}')"
  new_version="$(health_field version)"
  save_state "$prev_image" "$prev_ref" "$new_image" "$new_version"

  log "发布完成：${prev_version:-未知} → ${new_version:-未知}"
  docker ps --filter "name=^${SERVICE}$" --format '容器：{{.Names}}  {{.Status}}'
  env_drift
  local model; model="$(health_field model)"
  if [[ "$model" == "mock" ]]; then
    log "警告：health 里 model 是 mock，评分会用假数据。检查 $ENV_FILE 里的 MODEL_API_KEY"
  else
    log "模型：$model"
  fi
  log "备份：${backup_db_dir:-无}"
  log "回滚：sudo $0 rollback"
}

do_rollback() {
  [[ -f "$STATE_DIR/last-deploy.env" ]] || die "没有发布记录，无法回滚"
  # shellcheck disable=SC1091
  . "$STATE_DIR/last-deploy.env"
  [[ -n "${PREV_IMAGE:-}" ]] || die "上次发布没有记录旧镜像"
  log "回滚到发布前的镜像 $PREV_IMAGE（那次发布的目标版本是 ${VERSION:-未知}）"
  if ! rollback_to "$PREV_IMAGE" "${PREV_REF:-stkevintan/easy-grader-server:latest}"; then
    die "回滚后仍不健康"
  fi
  log "回滚完成：$(health_json)"
}

# 通过 ssh 的受限 key 调用时，参数在 SSH_ORIGINAL_COMMAND 里（由 easy-grader-remote 传进来）
MODE="${1:-}"
[[ -z "$MODE" && -n "${SSH_ORIGINAL_COMMAND:-}" ]] && MODE="$SSH_ORIGINAL_COMMAND"
case "${MODE:-deploy}" in
  deploy) do_deploy ;;
  check) do_check ;;
  backup) backup_db 1; prune_backups ;;
  rollback) do_rollback ;;
  -h | --help) sed -n '2,16p' "$0" ;;
  *) die "未知参数 $MODE（deploy|check|backup|rollback）" ;;
esac
