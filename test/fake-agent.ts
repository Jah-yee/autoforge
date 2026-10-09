/** A scriptable stand-in for a coding agent: `sh -c FAKE_AGENT fake <mode> [arg]`. */
export const FAKE_AGENT = `
set -e
target="\${TARGET_FILE:-hello.txt}"
case "$1" in
  edit) echo changed >> "$target" ;;
  add) echo new > added.txt ;;
  commit) echo c > committed.txt; git add -A; git -c user.name=f -c user.email=f@f commit -qm c ;;
  noop) true ;;
  fail-after-edit) echo changed >> "$target"; echo boom >&2; exit 3 ;;
  sleep) echo x >> "$target"; sleep 30 ;;
  flood) i=0; while [ $i -lt 5000 ]; do echo "line $i padding padding padding"; i=$((i+1)); done ;;
  echo-env) echo "key=$SECRET_KEY"; echo "task=$AUTOFORGE_TASK"; cat "$AUTOFORGE_TASK_FILE"; echo ;;
  argv) printf '%s\\n' "$2" > argv.txt; echo "argc=$#" ;;
  read-git-config) cat .git/config ;;
  nuke-git) rm -rf .git ;;
  id) id -u ;;
  latin1) printf 'caf\\351\\n' >> "$target" ;;
  unicode-name) echo x > "naïve file.txt" ;;
  hang-collect)
    git config diff.external "sh -c 'sleep 600'"
    git config core.fsmonitor "sleep 600"
    echo changed >> "$target" ;;
  *) echo "unknown mode $1" >&2; exit 64 ;;
esac
`;

export const fakeAgent = (mode: string, ...args: string[]): string[] => [
  "sh",
  "-c",
  FAKE_AGENT,
  "fake",
  mode,
  ...args,
];
