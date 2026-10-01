# Shared by deploy.sh and load-data.sh. Server access comes from deploy/deploy.env (git-ignored).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f deploy/deploy.env ] || { echo "Missing deploy/deploy.env (copy deploy/deploy.env.example)" >&2; exit 1; }
# shellcheck disable=SC1091
source deploy/deploy.env
DEPLOY_KEY="${DEPLOY_KEY/#\~/$HOME}"
SSH_OPTS=(-i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=15)
remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@"; }
