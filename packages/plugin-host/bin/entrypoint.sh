#!/bin/sh
# Container-level supervisor for one Plugin Host.
#
# The plugin worker is deliberately kept in a child process.  A synchronous
# worker bug can stop the HTTP event loop without exiting the process, so a
# Docker healthcheck alone is not enough under plain Compose: Docker marks the
# container unhealthy but does not restart it.  This supervisor owns that
# liveness decision and terminates only its child; the plugin code has no
# access to the Docker socket or to other Soulcloud processes.

set -eu

health_interval=${PLUGIN_HOST_HEALTH_INTERVAL_SECONDS:-5}
health_timeout=${PLUGIN_HOST_HEALTH_TIMEOUT_SECONDS:-2}
health_failures=${PLUGIN_HOST_HEALTH_FAILURES:-3}
startup_grace=${PLUGIN_HOST_HEALTH_STARTUP_GRACE_SECONDS:-15}
restart_delay=${PLUGIN_HOST_RESTART_DELAY_SECONDS:-1}
max_restarts=${PLUGIN_HOST_MAX_RESTARTS:-5}
restart_window=${PLUGIN_HOST_RESTART_WINDOW_SECONDS:-60}
port=${PLUGIN_HOST_PORT:-8090}

positive_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 0 ]
}

nonnegative_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 0 ]
}

if ! positive_integer "$health_interval" ||
  ! positive_integer "$health_timeout" ||
  ! positive_integer "$health_failures" ||
  ! nonnegative_integer "$startup_grace" ||
  ! positive_integer "$restart_delay" ||
  ! positive_integer "$max_restarts" ||
  ! positive_integer "$restart_window" ||
  ! positive_integer "$port" ||
  [ "$port" -gt 65535 ]; then
  echo "invalid Plugin Host supervisor configuration" >&2
  exit 64
fi

health_url="http://127.0.0.1:${port}/health"
child_pid=
stopping=0
restart_count=0
restart_window_started=$(date +%s)

terminate_child() {
  if [ -z "${child_pid}" ] || ! kill -0 "$child_pid" 2>/dev/null; then
    return 0
  fi
  kill -TERM "$child_pid" 2>/dev/null || true
  # Give the normal shutdown handler a short grace period, then make sure a
  # wedged event loop cannot keep the container alive forever.
  iteration=0
  while kill -0 "$child_pid" 2>/dev/null; do
    if [ "$iteration" -ge 20 ]; then
      kill -KILL "$child_pid" 2>/dev/null || true
      break
    fi
    iteration=$((iteration + 1))
    sleep 0.1
  done
}

on_signal() {
  stopping=1
  terminate_child
}

trap on_signal INT TERM HUP

probe_health() {
  wget -q -T "$health_timeout" -O - "$health_url" >/dev/null 2>&1
}

record_restart() {
  now=$(date +%s)
  if [ $((now - restart_window_started)) -ge "$restart_window" ]; then
    restart_window_started=$now
    restart_count=0
  fi
  restart_count=$((restart_count + 1))
  if [ "$restart_count" -gt "$max_restarts" ]; then
    echo "plugin-host exceeded ${max_restarts} restarts in ${restart_window}s" >&2
    exit 70
  fi
}

while :; do
  bun run packages/plugin-host/src/index.ts "$@" &
  child_pid=$!
  started_at=$(date +%s)
  consecutive_failures=0

  while :; do
    sleep "$health_interval"
    if [ "$stopping" -ne 0 ]; then
      terminate_child
      exit 143
    fi
    if ! kill -0 "$child_pid" 2>/dev/null; then
      break
    fi

    now=$(date +%s)
    if [ $((now - started_at)) -lt "$startup_grace" ]; then
      continue
    fi
    if probe_health; then
      consecutive_failures=0
      continue
    fi

    consecutive_failures=$((consecutive_failures + 1))
    echo "plugin-host health probe failed (${consecutive_failures}/${health_failures})" >&2
    if [ "$consecutive_failures" -ge "$health_failures" ]; then
      echo "plugin-host is unhealthy; terminating the wedged child" >&2
      terminate_child
      break
    fi
  done

  child_status=0
  wait "$child_pid" || child_status=$?
  child_pid=
  if [ "$stopping" -ne 0 ]; then
    exit 143
  fi
  echo "plugin-host child exited with status ${child_status}; restarting" >&2
  record_restart
  sleep "$restart_delay"
done
