#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# 从任何目录调用都保留调用者的工作目录，配置读取本项目的 .env。
exec node --env-file-if-exists="$project_dir/.env" "$project_dir/src/run.ts" "$@"
