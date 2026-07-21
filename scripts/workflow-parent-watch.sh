#!/bin/sh

WAKE='orchestrator: workflow-events-ready'

fail() {
  printf 'workflow-parent-watch: %s\n' "$1" >&2
  exit 2
}

require_value() {
  [ "$#" -ge 2 ] || fail "$1 requires a value"
  case "$2" in
    --*) fail "$1 requires a value" ;;
  esac
}

repo=
run=
since=
herdr_session=
parent_pane=
seen_repo=0
seen_run=0
seen_since=0
seen_herdr_session=0
seen_parent_pane=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$seen_repo" -eq 0 ] || fail "duplicate option: --repo"
      require_value "$@"
      repo=$2
      seen_repo=1
      shift 2
      ;;
    --run)
      [ "$seen_run" -eq 0 ] || fail "duplicate option: --run"
      require_value "$@"
      run=$2
      seen_run=1
      shift 2
      ;;
    --since)
      [ "$seen_since" -eq 0 ] || fail "duplicate option: --since"
      require_value "$@"
      since=$2
      seen_since=1
      shift 2
      ;;
    --herdr-session)
      [ "$seen_herdr_session" -eq 0 ] || fail "duplicate option: --herdr-session"
      require_value "$@"
      herdr_session=$2
      seen_herdr_session=1
      shift 2
      ;;
    --parent-pane)
      [ "$seen_parent_pane" -eq 0 ] || fail "duplicate option: --parent-pane"
      require_value "$@"
      parent_pane=$2
      seen_parent_pane=1
      shift 2
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$seen_repo" -eq 1 ] || fail "missing required option: --repo"
[ "$seen_run" -eq 1 ] || fail "missing required option: --run"
[ "$seen_since" -eq 1 ] || fail "missing required option: --since"
[ "$seen_herdr_session" -eq 1 ] || fail "missing required option: --herdr-session"
[ "$seen_parent_pane" -eq 1 ] || fail "missing required option: --parent-pane"

case "$repo" in
  -* | */*/* | *[!A-Za-z0-9._/-]*) fail "invalid --repo: $repo" ;;
  */*) ;;
  *) fail "invalid --repo: $repo" ;;
esac
repo_owner=${repo%%/*}
repo_name=${repo#*/}
case "$repo_owner" in
  '' | '.' | '..' | *[!A-Za-z0-9._-]*) fail "invalid --repo: $repo" ;;
esac
case "$repo_name" in
  '' | '.' | '..' | *[!A-Za-z0-9._-]*) fail "invalid --repo: $repo" ;;
esac

case "$run" in
  '' | *[!0-9]*) fail "invalid --run: $run" ;;
  *[1-9]*) ;;
  *) fail "invalid --run: $run" ;;
esac
case "$since" in
  '' | *[!0-9]*) fail "invalid --since: $since" ;;
esac

case "$herdr_session" in
  [A-Za-z0-9]*) ;;
  *) fail "invalid --herdr-session: $herdr_session" ;;
esac
case "$herdr_session" in
  *[!A-Za-z0-9:_-]*) fail "invalid --herdr-session: $herdr_session" ;;
esac
case "$parent_pane" in
  [A-Za-z0-9]*) ;;
  *) fail "invalid --parent-pane: $parent_pane" ;;
esac
case "$parent_pane" in
  *[!A-Za-z0-9:_-]*) fail "invalid --parent-pane: $parent_pane" ;;
esac

while :; do
  events=$(lh events \
    --since "$since" \
    --repo "$repo" \
    --type workflow_run \
    --run "$run" \
    --order asc \
    --limit 1) || {
    status=$?
    printf 'workflow-parent-watch: lh events failed with status %s\n' "$status" >&2
    exit "$status"
  }

  if [ -n "$events" ]; then
    herdr --session "$herdr_session" pane run "$parent_pane" "$WAKE" || {
      status=$?
      printf 'workflow-parent-watch: Herdr delivery failed with status %s\n' "$status" >&2
      exit "$status"
    }
    exit 0
  fi

  sleep 1 || {
    status=$?
    printf 'workflow-parent-watch: sleep failed with status %s\n' "$status" >&2
    exit "$status"
  }
done
