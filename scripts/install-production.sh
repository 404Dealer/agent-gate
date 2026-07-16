#!/usr/bin/env bash
# install-production.sh — install Nightdrop with a write-only inbox for Hermes/agents.
# Run as root from a reviewed checkout, e.g.:
#   sudo scripts/install-production.sh --agent-user nightdrop-agent --telegram-user-id 2061243435

set -euo pipefail

readonly TRUSTED_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$TRUSTED_PATH"

AGENT_USER="${SUDO_USER:-${USER:-}}"
TELEGRAM_USER_ID=""
INSTALL_DIR="/opt/nightdrop"
GRANT_AGENT_AUDIT_READ=false
DEPLOYMENT_PROFILE="standard"
ACKNOWLEDGE_AGENT_HOST_ADMIN_RISK=false
AGENT_PRIVILEGE_RISK_DETAILS=""
SERVICE_USER="nightdrop"
SERVICE_HOME="/home/$SERVICE_USER"
INBOX_GROUP="nightdrop-inbox"
MAILBOX_GROUP="nightdrop-mailbox"
MAILBOX_CLI_PATH="/usr/local/bin/nightdrop-mailbox"
SERVICE_NAME="nightdrop.service"
SOURCE_DIR="$(cd "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
IDENTITY_MARKER_DIR="/etc/nightdrop"
IDENTITY_MARKER="$IDENTITY_MARKER_DIR/managed-identities-v1"
IDENTITY_MARKER_VALUE="nightdrop-managed-identities-v1"
INSTALL_LOCK_PATH="/run/nightdrop-install.lock"
AGENT_UID_SNAPSHOT=""
AGENT_ACCESS_PROBE_PATH=""

usage() {
  /usr/bin/cat <<USAGE
Usage: sudo $0 --telegram-user-id ID [--agent-user USER] [--deployment-profile standard|strict]
             [--acknowledge-agent-host-admin-risk] [--install-dir /opt/nightdrop]
             [--grant-agent-audit-read]

Creates:
  - service user:        $SERVICE_USER
  - write-only group:    $INBOX_GROUP
  - mailbox-read group:  $MAILBOX_GROUP
  - root-owned app root: $INSTALL_DIR
  - private config dir:  $INSTALL_DIR/config
  - systemd service:     $SERVICE_NAME

Agent access to audit.log is denied by default. Pass --grant-agent-audit-read
only when the operator explicitly accepts exposing audit metadata to $AGENT_USER.

Agent isolation modes:
  standard  Allows unrelated supplementary groups, but never the private
            Nightdrop service group. Root-equivalent capability indicators
            require --acknowledge-agent-host-admin-risk and reduce the same-host
            structural guarantee. This is the default.
  strict    Requires a dedicated agent account whose only groups are its
            same-named primary group and the two Nightdrop capability groups.
            Privileged capability indicators are always rejected.

Secrets are left as \${PASS:...} placeholders in config/config.yaml; add them to
the Nightdrop service account's pass store before starting the service for a real provider.
USAGE
}

validate_agent_user() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]
}

validate_deployment_profile() {
  [[ "$1" == standard || "$1" == strict ]]
}

validate_agent_identity() {
  local agent_user="$1" agent_uid all_passwd name password uid gid remainder match_count=0
  validate_agent_user "$agent_user" || return 1
  [[ "$agent_user" != "root" && "$agent_user" != "$SERVICE_USER" ]] || return 1
  agent_uid="$(id -u -- "$agent_user")" || return 1
  [[ "$agent_uid" =~ ^[0-9]+$ ]] || return 1
  (( agent_uid > 0 )) || return 1
  all_passwd="$(getent passwd)" || return 1
  while IFS=: read -r name password uid gid remainder; do
    [[ -n "$name" ]] || continue
    if [[ "$name" == "$agent_user" || "$uid" == "$agent_uid" ]]; then
      [[ "$name" == "$agent_user" && "$uid" == "$agent_uid" ]] || return 1
      match_count=$((match_count + 1))
    fi
  done <<< "$all_passwd"
  (( match_count == 1 )) || return 1
}

capture_agent_identity_snapshot() {
  local agent_uid
  validate_agent_identity "$AGENT_USER" || return 1
  agent_uid="$(id -u -- "$AGENT_USER")" || return 1
  [[ "$agent_uid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$agent_uid"
}

validate_agent_identity_snapshot() {
  local current_uid
  [[ "$AGENT_UID_SNAPSHOT" =~ ^[1-9][0-9]*$ ]] || return 1
  validate_agent_identity "$AGENT_USER" || return 1
  current_uid="$(id -u -- "$AGENT_USER")" || return 1
  [[ "$current_uid" == "$AGENT_UID_SNAPSHOT" ]] || return 1
}

validate_telegram_user_id() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  if (( ${#value} > 16 )); then
    return 1
  fi
  if (( ${#value} == 16 && 10#$value > 9007199254740991 )); then
    return 1
  fi
}

validate_install_dir() {
  local value="$1"
  [[ "$value" =~ ^/opt/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || return 1
  [[ "$(/usr/bin/realpath -m -- "$value")" == "$value" ]]
}

validate_root_owned_entry_record() {
  local owner="$1" group="$2" mode="$3" require_owner_execute="$4" require_other_execute="$5" permissions
  [[ "$owner" == "root" && "$group" == "root" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  permissions=$((8#$mode))
  (( (permissions & 8#022) == 0 )) || return 1
  if [[ "$require_owner_execute" == true ]]; then
    (( (permissions & 8#100) != 0 )) || return 1
  fi
  if [[ "$require_other_execute" == true ]]; then
    (( (permissions & 8#001) != 0 )) || return 1
  fi
}

validate_root_owned_directory_record() {
  validate_root_owned_entry_record "$1" "$2" "$3" true "${4:-true}"
}

validate_root_owned_directory_chain() {
  local path="$1" require_other_execute="${2:-true}" current owner group mode
  [[ "$path" == /* && "$(/usr/bin/realpath -m -- "$path")" == "$path" ]] || return 1
  current="$path"
  while :; do
    [[ ! -L "$current" ]] || return 1
    if [[ -e "$current" ]]; then
      [[ -d "$current" ]] || return 1
      read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$current") || return 1
      validate_root_owned_directory_record "$owner" "$group" "$mode" "$require_other_execute" || return 1
    fi
    [[ "$current" != "/" ]] || break
    current="$(/usr/bin/dirname -- "$current")" || return 1
  done
}

validate_trusted_source_tree() {
  local manifest path owner group mode status=0
  validate_root_owned_directory_chain "$SOURCE_DIR" false || return 1
  manifest="$(mktemp /run/nightdrop-source-list.XXXXXXXX)" || return 1
  chmod 600 "$manifest" || { rm -f -- "$manifest"; return 1; }
  if ! find "$SOURCE_DIR" \
    \( -path "$SOURCE_DIR/.git" -o -path "$SOURCE_DIR/.hermes" -o -path "$SOURCE_DIR/node_modules" -o -path "$SOURCE_DIR/dist" \
       -o -path "$SOURCE_DIR/config" -o -path "$SOURCE_DIR/config.yaml" -o -path "$SOURCE_DIR/audit.log" -o -path "$SOURCE_DIR/drafts" \
       -o -path "$SOURCE_DIR/.rollback-*" -o -path "$SOURCE_DIR/.build-*" \) -prune -o -print0 > "$manifest"; then
    rm -f -- "$manifest"
    return 1
  fi
  while IFS= read -r -d '' path; do
    if [[ -L "$path" || ( ! -f "$path" && ! -d "$path" ) ]]; then
      status=1
      break
    fi
    read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$path") || { status=1; break; }
    if [[ -d "$path" ]]; then
      validate_root_owned_directory_record "$owner" "$group" "$mode" false || { status=1; break; }
    else
      validate_root_owned_entry_record "$owner" "$group" "$mode" false false || { status=1; break; }
    fi
  done < "$manifest"
  rm -f -- "$manifest" || return 1
  (( status == 0 ))
}

login_definition_limit() {
  local expected="$1" key value remainder
  while read -r key value remainder; do
    [[ "$key" == "$expected" && "$value" =~ ^[1-9][0-9]*$ && -z "${remainder:-}" ]] || continue
    printf '%s\n' "$value"
    return 0
  done < /etc/login.defs
  return 1
}

validate_service_identity_record() {
  local record="$1" status_record="$2" primary_group_record="$3" uid_min="$4" gid_min="$5"
  local name password uid gid home shell remainder status_name lock_state
  local primary_name primary_password primary_gid primary_members
  IFS=: read -r name password uid gid _ home shell remainder <<< "$record"
  read -r status_name lock_state _ <<< "$status_record"
  IFS=: read -r primary_name primary_password primary_gid primary_members _ <<< "$primary_group_record"
  [[ "$name" == "$SERVICE_USER" && "$password" == "x" ]] || return 1
  [[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$uid_min" =~ ^[1-9][0-9]*$ && "$gid_min" =~ ^[1-9][0-9]*$ ]] || return 1
  (( uid < uid_min && gid < gid_min )) || return 1
  [[ "$home" == "$SERVICE_HOME" && "$shell" == "/usr/sbin/nologin" ]] || return 1
  [[ "$status_name" == "$SERVICE_USER" && "$lock_state" == "L" ]] || return 1
  [[ "$primary_name" == "$SERVICE_USER" && "$primary_password" == "x" ]] || return 1
  [[ "$primary_gid" == "$gid" && -z "$primary_members" ]] || return 1
}

validate_capability_group_record() {
  local record="$1" expected_group="$2" service_user="$3" agent_user="$4" gid_min="$5"
  local name password gid members remainder member saw_service=false saw_agent=false
  local -a member_list=()
  IFS=: read -r name password gid members remainder <<< "$record"
  [[ "$name" == "$expected_group" && "$password" == "x" ]] || return 1
  [[ "$gid" =~ ^[1-9][0-9]*$ && "$gid_min" =~ ^[1-9][0-9]*$ ]] || return 1
  (( gid < gid_min )) || return 1
  [[ -n "$members" ]] || return 1
  IFS=',' read -r -a member_list <<< "$members"
  for member in "${member_list[@]}"; do
    if [[ "$member" == "$service_user" ]]; then
      [[ "$saw_service" == false ]] || return 1
      saw_service=true
    elif [[ "$member" == "$agent_user" ]]; then
      [[ "$saw_agent" == false ]] || return 1
      saw_agent=true
    else
      return 1
    fi
  done
  [[ "$saw_service" == true && "$saw_agent" == true ]] || return 1
}

validate_numeric_identity_graph() {
  local passwd_records="$1" group_records="$2" service_user="$3" inbox_group="$4" mailbox_group="$5"
  local service_uid="$6" primary_gid="$7" inbox_gid="$8" mailbox_gid="$9"
  local name password uid gid remainder expected_name
  local service_name_count=0 service_uid_count=0 primary_user_count=0
  local primary_name_count=0 inbox_name_count=0 mailbox_name_count=0
  local primary_gid_count=0 inbox_gid_count=0 mailbox_gid_count=0
  [[ "$service_uid" =~ ^[1-9][0-9]*$ && "$primary_gid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$inbox_gid" =~ ^[1-9][0-9]*$ && "$mailbox_gid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$primary_gid" != "$inbox_gid" && "$primary_gid" != "$mailbox_gid" && "$inbox_gid" != "$mailbox_gid" ]] || return 1

  while IFS=: read -r name password uid gid remainder; do
    [[ -n "$name" ]] || continue
    if [[ "$name" == "$service_user" ]]; then
      [[ "$uid" == "$service_uid" && "$gid" == "$primary_gid" ]] || return 1
      service_name_count=$((service_name_count + 1))
    fi
    if [[ "$uid" == "$service_uid" ]]; then
      [[ "$name" == "$service_user" ]] || return 1
      service_uid_count=$((service_uid_count + 1))
    fi
    if [[ "$gid" == "$primary_gid" ]]; then
      [[ "$name" == "$service_user" ]] || return 1
      primary_user_count=$((primary_user_count + 1))
    fi
    [[ "$gid" != "$inbox_gid" && "$gid" != "$mailbox_gid" ]] || return 1
  done <<< "$passwd_records"
  (( service_name_count == 1 && service_uid_count == 1 && primary_user_count == 1 )) || return 1

  while IFS=: read -r name password gid remainder; do
    [[ -n "$name" ]] || continue
    expected_name=""
    if [[ "$name" == "$service_user" ]]; then [[ "$gid" == "$primary_gid" ]] || return 1; primary_name_count=$((primary_name_count + 1)); fi
    if [[ "$name" == "$inbox_group" ]]; then [[ "$gid" == "$inbox_gid" ]] || return 1; inbox_name_count=$((inbox_name_count + 1)); fi
    if [[ "$name" == "$mailbox_group" ]]; then [[ "$gid" == "$mailbox_gid" ]] || return 1; mailbox_name_count=$((mailbox_name_count + 1)); fi
    if [[ "$gid" == "$primary_gid" ]]; then expected_name="$service_user"; primary_gid_count=$((primary_gid_count + 1)); fi
    if [[ "$gid" == "$inbox_gid" ]]; then expected_name="$inbox_group"; inbox_gid_count=$((inbox_gid_count + 1)); fi
    if [[ "$gid" == "$mailbox_gid" ]]; then expected_name="$mailbox_group"; mailbox_gid_count=$((mailbox_gid_count + 1)); fi
    [[ -z "$expected_name" || "$name" == "$expected_name" ]] || return 1
  done <<< "$group_records"
  (( primary_name_count == 1 && inbox_name_count == 1 && mailbox_name_count == 1 )) || return 1
  (( primary_gid_count == 1 && inbox_gid_count == 1 && mailbox_gid_count == 1 )) || return 1
}

validate_agent_primary_group_for_profile() {
  local agent_primary_group="$1" agent_user="$2" isolation_mode="$3"
  [[ -n "$agent_primary_group" ]] || return 1
  [[ "$isolation_mode" == standard || "$isolation_mode" == strict ]] || return 1
  [[ "$isolation_mode" != strict || "$agent_primary_group" == "$agent_user" ]] || return 1
}

validate_agent_group_boundary() {
  local agent_groups="$1" agent_primary_group="$2" agent_user="$3" inbox_group="$4" mailbox_group="$5" require_capabilities="$6"
  local isolation_mode="${7:-strict}"
  local group saw_primary=false saw_inbox=false saw_mailbox=false group_count=0
  [[ "$require_capabilities" == true || "$require_capabilities" == false ]] || return 1
  [[ "$isolation_mode" == standard || "$isolation_mode" == strict ]] || return 1
  validate_agent_primary_group_for_profile "$agent_primary_group" "$agent_user" "$isolation_mode" || return 1
  [[ "$agent_primary_group" != "$SERVICE_USER" && "$agent_primary_group" != "$inbox_group" && "$agent_primary_group" != "$mailbox_group" ]] || return 1
  for group in $agent_groups; do
    group_count=$((group_count + 1))
    if [[ "$group" == "$SERVICE_USER" ]]; then return 1
    elif [[ "$group" == "$agent_primary_group" ]]; then [[ "$saw_primary" == false ]] || return 1; saw_primary=true
    elif [[ "$group" == "$inbox_group" ]]; then [[ "$saw_inbox" == false ]] || return 1; saw_inbox=true
    elif [[ "$group" == "$mailbox_group" ]]; then [[ "$saw_mailbox" == false ]] || return 1; saw_mailbox=true
    elif [[ "$isolation_mode" == strict ]]; then return 1
    fi
  done
  [[ "$saw_primary" == true ]] || return 1
  if [[ "$require_capabilities" == true ]]; then
    [[ "$saw_inbox" == true && "$saw_mailbox" == true ]] || return 1
    [[ "$isolation_mode" != strict || "$group_count" -eq 3 ]] || return 1
  else
    [[ "$saw_inbox" == "$saw_mailbox" ]] || return 1
    if [[ "$isolation_mode" == strict ]]; then
      [[ "$group_count" -eq 1 || "$group_count" -eq 3 ]] || return 1
    fi
  fi
}

validate_effective_group_graph() {
  local service_groups="$1" agent_groups="$2" primary_group="$3" inbox_group="$4" mailbox_group="$5" agent_primary_group="$6"
  local isolation_mode="${7:-strict}"
  local agent_user="${8:-$agent_primary_group}"
  local group saw_primary=false saw_inbox=false saw_mailbox=false service_count=0
  for group in $service_groups; do
    service_count=$((service_count + 1))
    if [[ "$group" == "$primary_group" ]]; then [[ "$saw_primary" == false ]] || return 1; saw_primary=true
    elif [[ "$group" == "$inbox_group" ]]; then [[ "$saw_inbox" == false ]] || return 1; saw_inbox=true
    elif [[ "$group" == "$mailbox_group" ]]; then [[ "$saw_mailbox" == false ]] || return 1; saw_mailbox=true
    else return 1
    fi
  done
  [[ "$service_count" -eq 3 && "$saw_primary" == true && "$saw_inbox" == true && "$saw_mailbox" == true ]] || return 1
  validate_agent_group_boundary "$agent_groups" "$agent_primary_group" "$agent_user" "$inbox_group" "$mailbox_group" true "$isolation_mode" || return 1
}

validate_agent_group_boundary_preflight() {
  local agent_primary_group agent_groups
  agent_primary_group="$(id -gn "$AGENT_USER")" || return 1
  agent_groups="$(id -Gn "$AGENT_USER")" || return 1
  validate_agent_group_boundary "$agent_groups" "$agent_primary_group" "$AGENT_USER" "$INBOX_GROUP" "$MAILBOX_GROUP" false "$DEPLOYMENT_PROFILE" || return 1
}

direct_agent_host_admin_present() {
  local broad_sudo="$1" passwordless_doas="$2" writable_admin_path="$3" value
  for value in "$broad_sudo" "$passwordless_doas" "$writable_admin_path"; do
    [[ "$value" == true || "$value" == false ]] || return 2
  done
  [[ "$broad_sudo" == true || "$passwordless_doas" == true || "$writable_admin_path" == true ]]
}

resolve_optional_trusted_executable() {
  local name="$1" discovered
  if ! discovered="$(command -v -- "$name" 2>/dev/null)"; then
    return 1
  fi
  [[ -n "$discovered" ]] || return 1
  resolve_trusted_executable "$name" 2>/dev/null || return 2
}

agent_test_path_access() {
  local status
  if runuser -u "$AGENT_USER" -- env -i \
    HOME="/nonexistent" PATH="$TRUSTED_PATH" LANG=C LC_ALL=C \
    /usr/bin/test "$1" "$2" >/dev/null 2>&1; then
    return 0
  else
    status=$?
  fi
  [[ "$status" -eq 1 ]] && return 1
  return 2
}

record_agent_path_access() {
  local result_name="$1" predicate="$2" path="$3" status
  [[ "$result_name" =~ ^can_[a-z_]+$ ]] || return 2
  if agent_test_path_access "$predicate" "$path"; then
    printf -v "$result_name" '%s' true
    return 0
  else
    status=$?
  fi
  [[ "$status" -eq 1 ]] || return 2
}

root_owned_path_writable_by_agent() {
  local path="$1" owner_uid status
  owner_uid="$(/usr/bin/stat -Lc '%u' -- "$path" 2>/dev/null)" || return 2
  [[ "$owner_uid" == "0" ]] || return 1
  if agent_test_path_access -w "$path"; then
    return 0
  else
    status=$?
  fi
  [[ "$status" -eq 1 ]] && return 1
  return 2
}

detect_agent_privilege_risk() {
  local sudo_bin doas_bin probe_output probe_status socket path child status
  local root_nopasswd_pattern='\((root|ALL)([[:space:]]*:[^)]*)?\)[[:space:]]+NOPASSWD:'
  local broad_sudo=false passwordless_doas=false writable_admin_path=false
  local -a admin_children=()
  AGENT_PRIVILEGE_RISK_DETAILS=""

  probe_output="$(runuser -u "$AGENT_USER" -- env -i \
    HOME="/nonexistent" PATH="$TRUSTED_PATH" LANG=C LC_ALL=C \
    /usr/bin/id -u 2>/dev/null)" || return 2
  [[ "$probe_output" == "$AGENT_UID_SNAPSHOT" ]] || return 2

  if sudo_bin="$(resolve_optional_trusted_executable sudo)"; then
    if probe_output="$(runuser -u "$AGENT_USER" -- env -i \
      HOME="/nonexistent" PATH="$TRUSTED_PATH" LANG=C LC_ALL=C \
      "$sudo_bin" -n -k -l 2>&1)"; then
      if [[ "$probe_output" =~ $root_nopasswd_pattern ]]; then
        broad_sudo=true
        AGENT_PRIVILEGE_RISK_DETAILS+="${AGENT_PRIVILEGE_RISK_DETAILS:+,}root-nopasswd-sudo-policy"
      fi
    else
      probe_status=$?
      [[ "$probe_status" -eq 1 ]] || return 2
      [[ "$probe_output" == *"a password is required"* || \
         "$probe_output" == *"is not allowed to execute"* || \
         "$probe_output" == *"may not run sudo"* ]] || return 2
    fi
  else
    status=$?
    [[ "$status" -eq 1 ]] || return 2
  fi

  if doas_bin="$(resolve_optional_trusted_executable doas)"; then
    if probe_output="$(runuser -u "$AGENT_USER" -- env -i \
      HOME="/nonexistent" PATH="$TRUSTED_PATH" LANG=C LC_ALL=C \
      "$doas_bin" -n /usr/bin/id -u 2>&1)"; then
      [[ "$probe_output" == "0" ]] || return 2
      passwordless_doas=true
      AGENT_PRIVILEGE_RISK_DETAILS+="${AGENT_PRIVILEGE_RISK_DETAILS:+,}passwordless-root-doas"
    else
      probe_status=$?
      [[ "$probe_status" -eq 1 ]] || return 2
      [[ "$probe_output" == *"Authorization required"* || \
         "$probe_output" == *"Operation not permitted"* || \
         "$probe_output" == *"not permitted"* ]] || return 2
    fi
  else
    status=$?
    [[ "$status" -eq 1 ]] || return 2
  fi

  for socket in \
    /var/run/docker.sock \
    /run/docker.sock \
    /var/snap/lxd/common/lxd/unix.socket \
    /var/lib/lxd/unix.socket \
    /var/lib/incus/unix.socket \
    /var/run/libvirt/libvirt-sock; do
    [[ -S "$socket" ]] || continue
    if root_owned_path_writable_by_agent "$socket"; then
      writable_admin_path=true
      AGENT_PRIVILEGE_RISK_DETAILS+="${AGENT_PRIVILEGE_RISK_DETAILS:+,}writable-root-control:$socket"
      break
    else
      status=$?
    fi
    [[ "$status" -eq 1 ]] || return 2
  done

  for path in /etc/sudoers /etc/sudoers.d /etc/systemd/system /usr/local/bin /usr/local/sbin; do
    [[ -e "$path" ]] || continue
    if root_owned_path_writable_by_agent "$path"; then
      writable_admin_path=true
      AGENT_PRIVILEGE_RISK_DETAILS+="${AGENT_PRIVILEGE_RISK_DETAILS:+,}writable-root-path:$path"
      break
    else
      status=$?
    fi
    [[ "$status" -eq 1 ]] || return 2
    if [[ -d "$path" && ! -L "$path" ]]; then
      shopt -s nullglob dotglob
      admin_children=("$path"/*)
      shopt -u nullglob dotglob
      for child in "${admin_children[@]}"; do
        [[ -e "$child" ]] || continue
        if root_owned_path_writable_by_agent "$child"; then
          writable_admin_path=true
          AGENT_PRIVILEGE_RISK_DETAILS+="${AGENT_PRIVILEGE_RISK_DETAILS:+,}writable-root-path:$child"
          break 2
        else
          status=$?
        fi
        [[ "$status" -eq 1 ]] || return 2
      done
    fi
  done

  direct_agent_host_admin_present "$broad_sudo" "$passwordless_doas" "$writable_admin_path"
}

validate_privileged_agent_acknowledgment() {
  local isolation_mode="$1" privileged_risk="$2" acknowledged="$3"
  [[ "$isolation_mode" == standard || "$isolation_mode" == strict ]] || return 1
  [[ "$privileged_risk" == true || "$privileged_risk" == false ]] || return 1
  [[ "$acknowledged" == true || "$acknowledged" == false ]] || return 1
  if [[ "$isolation_mode" == strict ]]; then
    [[ "$privileged_risk" == false && "$acknowledged" == false ]] || return 1
  elif [[ "$privileged_risk" == true ]]; then
    [[ "$acknowledged" == true ]] || return 1
  fi
}

validate_agent_access_probe_results() {
  local can_write_inbox="$1" can_traverse_inbox="$2" can_list_inbox="$3"
  local can_read_config="$4" can_write_config="$5" can_read_home="$6"
  local can_read_private="$7" can_write_private="$8" can_read_audit="$9"
  local can_write_audit="${10}" grant_audit_read="${11}"
  local value
  for value in \
    "$can_write_inbox" "$can_traverse_inbox" "$can_list_inbox" \
    "$can_read_config" "$can_write_config" "$can_read_home" \
    "$can_read_private" "$can_write_private" "$can_read_audit" \
    "$can_write_audit" "$grant_audit_read"; do
    [[ "$value" == true || "$value" == false ]] || return 1
  done
  [[ "$can_write_inbox" == true && "$can_traverse_inbox" == true ]] || return 1
  [[ "$can_list_inbox" == false ]] || return 1
  [[ "$can_read_config" == false && "$can_write_config" == false ]] || return 1
  [[ "$can_read_home" == false ]] || return 1
  [[ "$can_read_private" == false && "$can_write_private" == false ]] || return 1
  [[ "$can_write_audit" == false ]] || return 1
  [[ "$can_read_audit" == "$grant_audit_read" ]] || return 1
}

cleanup_agent_access_probe() {
  [[ -n "$AGENT_ACCESS_PROBE_PATH" ]] || return 0
  case "$AGENT_ACCESS_PROBE_PATH" in
    "$INSTALL_DIR/drafts/inbox/.nightdrop-access-probe."*) ;;
    *) return 1 ;;
  esac
  rm -f -- "$AGENT_ACCESS_PROBE_PATH" || return 1
  [[ ! -e "$AGENT_ACCESS_PROBE_PATH" && ! -L "$AGENT_ACCESS_PROBE_PATH" ]] || return 1
  AGENT_ACCESS_PROBE_PATH=""
}

verify_agent_access_boundary() {
  local inbox="$INSTALL_DIR/drafts/inbox" private_state="$INSTALL_DIR/drafts/pending"
  local config="$INSTALL_DIR/config/config.yaml" audit="$INSTALL_DIR/audit.log"
  local owner
  local can_write_inbox=false can_traverse_inbox=false can_list_inbox=false
  local can_read_config=false can_write_config=false can_read_home=false
  local can_read_private=false can_write_private=false can_read_audit=false can_write_audit=false

  validate_agent_identity_snapshot || return 1
  AGENT_ACCESS_PROBE_PATH="$inbox/.nightdrop-access-probe.$$.${RANDOM}"
  [[ ! -e "$AGENT_ACCESS_PROBE_PATH" && ! -L "$AGENT_ACCESS_PROBE_PATH" ]] || return 1
  if runuser -u "$AGENT_USER" -- env -i \
    HOME="/nonexistent" PATH="$TRUSTED_PATH" LANG=C LC_ALL=C \
    /usr/bin/touch -- "$AGENT_ACCESS_PROBE_PATH" >/dev/null 2>&1; then
    if [[ -f "$AGENT_ACCESS_PROBE_PATH" && ! -L "$AGENT_ACCESS_PROBE_PATH" ]]; then
      owner="$(/usr/bin/stat -Lc '%U' -- "$AGENT_ACCESS_PROBE_PATH" 2>/dev/null || true)"
      if [[ "$owner" == "$AGENT_USER" ]]; then
        can_write_inbox=true
      fi
    fi
  fi
  cleanup_agent_access_probe || return 1

  record_agent_path_access can_traverse_inbox -x "$inbox" || return 1
  record_agent_path_access can_list_inbox -r "$inbox" || return 1
  record_agent_path_access can_read_config -r "$config" || return 1
  record_agent_path_access can_write_config -w "$config" || return 1
  record_agent_path_access can_read_home -r "$SERVICE_HOME" || return 1
  record_agent_path_access can_read_private -r "$private_state" || return 1
  record_agent_path_access can_write_private -w "$private_state" || return 1
  record_agent_path_access can_read_audit -r "$audit" || return 1
  record_agent_path_access can_write_audit -w "$audit" || return 1

  validate_agent_identity_snapshot || return 1
  validate_agent_access_probe_results \
    "$can_write_inbox" "$can_traverse_inbox" "$can_list_inbox" \
    "$can_read_config" "$can_write_config" "$can_read_home" \
    "$can_read_private" "$can_write_private" "$can_read_audit" \
    "$can_write_audit" "$GRANT_AGENT_AUDIT_READ"
}

validate_private_directory() {
  local path="$1" expected_owner="$2" expected_group="$3" expected_mode="$4"
  local owner group mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$path") || return 1
  [[ "$owner" == "$expected_owner" && "$group" == "$expected_group" && "$mode" == "$expected_mode" ]] || return 1
}

validate_service_home_parent_record() {
  local owner="$1" group="$2" mode="$3" permissions
  [[ "$owner" == "root" && "$group" == "root" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  permissions=$((8#$mode))
  (( (permissions & 8#022) == 0 )) || return 1
  (( (permissions & 8#001) != 0 )) || return 1
}

validate_service_home_parent() {
  local parent="${SERVICE_HOME%/*}" owner group mode
  [[ "$SERVICE_HOME" == "/home/$SERVICE_USER" ]] || return 1
  [[ -d "$parent" && ! -L "$parent" ]] || return 1
  read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$parent") || return 1
  validate_service_home_parent_record "$owner" "$group" "$mode" || return 1
}

validate_managed_identity_marker() {
  local owner group mode marker_value
  [[ -d "$IDENTITY_MARKER_DIR" && ! -L "$IDENTITY_MARKER_DIR" ]] || return 1
  read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$IDENTITY_MARKER_DIR") || return 1
  [[ "$owner" == "root" && "$group" == "root" && "$mode" == "755" ]] || return 1
  [[ -f "$IDENTITY_MARKER" && ! -L "$IDENTITY_MARKER" ]] || return 1
  read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$IDENTITY_MARKER") || return 1
  [[ "$owner" == "root" && "$group" == "root" && "$mode" == "600" ]] || return 1
  marker_value="$(< "$IDENTITY_MARKER")"
  [[ "$marker_value" == "$IDENTITY_MARKER_VALUE" ]] || return 1
}

validate_managed_identity_records() {
  local uid_min gid_min service_record status_record primary_record inbox_record mailbox_record
  local all_passwd all_groups service_groups agent_groups agent_primary_group service_uid service_gid inbox_gid mailbox_gid
  validate_agent_identity_snapshot || return 1
  uid_min="$(login_definition_limit UID_MIN)" || return 1
  gid_min="$(login_definition_limit GID_MIN)" || return 1
  service_record="$(getent passwd "$SERVICE_USER")" || return 1
  status_record="$(passwd -S "$SERVICE_USER")" || return 1
  primary_record="$(getent group "$SERVICE_USER")" || return 1
  inbox_record="$(getent group "$INBOX_GROUP")" || return 1
  mailbox_record="$(getent group "$MAILBOX_GROUP")" || return 1
  all_passwd="$(getent passwd)" || return 1
  all_groups="$(getent group)" || return 1
  service_groups="$(id -Gn "$SERVICE_USER")" || return 1
  agent_groups="$(id -Gn "$AGENT_USER")" || return 1
  agent_primary_group="$(id -gn "$AGENT_USER")" || return 1
  validate_agent_primary_group_for_profile "$agent_primary_group" "$AGENT_USER" "$DEPLOYMENT_PROFILE" || return 1
  IFS=: read -r _ _ service_uid service_gid _ <<< "$service_record"
  IFS=: read -r _ _ inbox_gid _ <<< "$inbox_record"
  IFS=: read -r _ _ mailbox_gid _ <<< "$mailbox_record"

  validate_service_identity_record "$service_record" "$status_record" "$primary_record" "$uid_min" "$gid_min" || return 1
  validate_capability_group_record "$inbox_record" "$INBOX_GROUP" "$SERVICE_USER" "$AGENT_USER" "$gid_min" || return 1
  validate_capability_group_record "$mailbox_record" "$MAILBOX_GROUP" "$SERVICE_USER" "$AGENT_USER" "$gid_min" || return 1
  validate_numeric_identity_graph \
    "$all_passwd" "$all_groups" "$SERVICE_USER" "$INBOX_GROUP" "$MAILBOX_GROUP" \
    "$service_uid" "$service_gid" "$inbox_gid" "$mailbox_gid" || return 1
  validate_effective_group_graph \
    "$service_groups" "$agent_groups" "$SERVICE_USER" "$INBOX_GROUP" "$MAILBOX_GROUP" "$agent_primary_group" "$DEPLOYMENT_PROFILE" "$AGENT_USER" || return 1
  validate_service_home_parent || return 1
  validate_private_directory "$SERVICE_HOME" "$SERVICE_USER" "$SERVICE_USER" 700 || return 1
}

remove_fresh_identity_path() {
  local path="$1"
  if [[ -d "$path" && ! -L "$path" ]]; then
    rmdir -- "$path"
  elif [[ -e "$path" || -L "$path" ]]; then
    rm -f -- "$path"
  fi
}

rollback_fresh_nightdrop_identities() {
  local cleanup_failed=false group state

  remove_fresh_identity_path "$IDENTITY_MARKER" || cleanup_failed=true
  remove_fresh_identity_path "$IDENTITY_MARKER_DIR" || cleanup_failed=true

  state=""
  if state="$(nss_entry_state passwd "$SERVICE_USER")"; then
    if [[ "$state" == "present" ]]; then
      userdel "$SERVICE_USER" >/dev/null 2>&1 || cleanup_failed=true
    fi
  else
    cleanup_failed=true
    userdel "$SERVICE_USER" >/dev/null 2>&1 || true
  fi
  if [[ -e "$SERVICE_HOME" || -L "$SERVICE_HOME" ]]; then
    rm -rf --one-file-system -- "$SERVICE_HOME" || cleanup_failed=true
  fi

  for group in "$MAILBOX_GROUP" "$INBOX_GROUP" "$SERVICE_USER"; do
    state=""
    if state="$(nss_entry_state group "$group")"; then
      if [[ "$state" == "present" ]]; then
        groupdel "$group" >/dev/null 2>&1 || cleanup_failed=true
      fi
    else
      cleanup_failed=true
      groupdel "$group" >/dev/null 2>&1 || true
    fi
  done

  nss_entry_is_absent passwd "$SERVICE_USER" || cleanup_failed=true
  nss_entry_is_absent group "$SERVICE_USER" || cleanup_failed=true
  nss_entry_is_absent group "$INBOX_GROUP" || cleanup_failed=true
  nss_entry_is_absent group "$MAILBOX_GROUP" || cleanup_failed=true
  if [[ -e "$SERVICE_HOME" || -L "$SERVICE_HOME" || -e "$IDENTITY_MARKER_DIR" || -L "$IDENTITY_MARKER_DIR" ]]; then
    cleanup_failed=true
  fi

  [[ "$cleanup_failed" == false ]]
}

fail_fresh_identity_transaction() {
  local message="$1"
  echo "$message" >&2
  if ! rollback_fresh_nightdrop_identities; then
    echo "Nightdrop identity rollback was incomplete; remove only the reported Nightdrop identities and paths before retrying." >&2
  fi
  return 1
}

run_fresh_identity_step() {
  local description="$1"
  shift
  if "$@"; then
    return 0
  fi
  fail_fresh_identity_transaction "Failed to $description; rolling back fresh Nightdrop identities."
}

validate_nss_enumeration() {
  getent passwd >/dev/null || {
    echo "Could not enumerate the passwd database safely." >&2
    return 1
  }
  getent group >/dev/null || {
    echo "Could not enumerate the group database safely." >&2
    return 1
  }
}

nss_entry_state() {
  local database="$1" key="$2" status
  if getent "$database" "$key" >/dev/null; then
    printf 'present\n'
    return 0
  else
    status=$?
  fi
  if (( status == 2 )); then
    printf 'absent\n'
    return 0
  fi
  echo "Could not resolve $database entry safely: $key (getent status $status)." >&2
  return 1
}

nss_entry_is_absent() {
  local state
  state="$(nss_entry_state "$1" "$2")" || return 1
  [[ "$state" == "absent" ]]
}

prepare_nightdrop_identities() {
  local existing_count=0 passwd_state primary_group_state inbox_group_state mailbox_group_state
  validate_agent_identity_snapshot || return 1
  validate_nss_enumeration || return 1
  passwd_state="$(nss_entry_state passwd "$SERVICE_USER")" || return 1
  primary_group_state="$(nss_entry_state group "$SERVICE_USER")" || return 1
  inbox_group_state="$(nss_entry_state group "$INBOX_GROUP")" || return 1
  mailbox_group_state="$(nss_entry_state group "$MAILBOX_GROUP")" || return 1
  if [[ "$passwd_state" == "present" ]]; then existing_count=$((existing_count + 1)); fi
  if [[ "$primary_group_state" == "present" ]]; then existing_count=$((existing_count + 1)); fi
  if [[ "$inbox_group_state" == "present" ]]; then existing_count=$((existing_count + 1)); fi
  if [[ "$mailbox_group_state" == "present" ]]; then existing_count=$((existing_count + 1)); fi

  if (( existing_count != 0 )); then
    if (( existing_count != 4 )) || ! validate_managed_identity_marker || ! validate_managed_identity_records; then
      echo "Refusing unmanaged or inconsistent Nightdrop user/group identity collision." >&2
      return 1
    fi
    return 0
  fi

  if [[ -e "$IDENTITY_MARKER_DIR" || -L "$IDENTITY_MARKER_DIR" ]]; then
    echo "Refusing unmanaged Nightdrop identity marker path." >&2
    return 1
  fi
  if [[ -e "$SERVICE_HOME" || -L "$SERVICE_HOME" ]] || ! validate_service_home_parent; then
    echo "Refusing pre-existing or unsafe Nightdrop service home path." >&2
    return 1
  fi

  run_fresh_identity_step "create the Nightdrop primary group" \
    groupadd --system "$SERVICE_USER" || return 1
  run_fresh_identity_step "create the Nightdrop service user" \
    useradd -r -m -d "$SERVICE_HOME" -g "$SERVICE_USER" -s /usr/sbin/nologin "$SERVICE_USER" || return 1
  run_fresh_identity_step "set Nightdrop service-home ownership" \
    chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME" || return 1
  run_fresh_identity_step "set Nightdrop service-home permissions" \
    chmod 700 "$SERVICE_HOME" || return 1
  run_fresh_identity_step "create the inbox capability group" \
    groupadd --system "$INBOX_GROUP" || return 1
  run_fresh_identity_step "create the mailbox capability group" \
    groupadd --system "$MAILBOX_GROUP" || return 1
  run_fresh_identity_step "grant the service capability groups" \
    usermod -aG "$INBOX_GROUP,$MAILBOX_GROUP" "$SERVICE_USER" || return 1
  if ! validate_agent_identity_snapshot; then
    fail_fresh_identity_transaction "Selected agent identity changed during installation; rolling back fresh Nightdrop identities."
    return 1
  fi
  run_fresh_identity_step "grant the agent capability groups" \
    usermod -aG "$INBOX_GROUP,$MAILBOX_GROUP" "$AGENT_USER" || return 1
  if ! validate_managed_identity_records; then
    fail_fresh_identity_transaction "Created Nightdrop identities failed security validation; rolling them back."
    return 1
  fi
  run_fresh_identity_step "create the managed-identity marker directory" \
    install -d -o root -g root -m 0755 "$IDENTITY_MARKER_DIR" || return 1
  run_fresh_identity_step "create the managed-identity marker" \
    install -o root -g root -m 0600 /dev/null "$IDENTITY_MARKER" || return 1
  if ! printf '%s\n' "$IDENTITY_MARKER_VALUE" > "$IDENTITY_MARKER"; then
    fail_fresh_identity_transaction "Failed to write the managed-identity marker; rolling back fresh Nightdrop identities."
    return 1
  fi
  if ! validate_managed_identity_marker; then
    fail_fresh_identity_transaction "Created Nightdrop identity marker failed validation; rolling back fresh Nightdrop identities."
    return 1
  fi
  return 0
}

validate_trusted_path() {
  local directory canonical
  local -a directories=()
  IFS=':' read -r -a directories <<< "$TRUSTED_PATH"
  for directory in "${directories[@]}"; do
    [[ -d "$directory" ]] || continue
    canonical="$(/usr/bin/readlink -f -- "$directory")" || return 1
    validate_root_owned_directory_chain "$canonical" false || {
      echo "Refusing untrusted executable path directory or ancestor: $directory" >&2
      return 1
    }
  done
}

acquire_install_lock() {
  local owner group mode
  if [[ -L "$INSTALL_LOCK_PATH" || ( -e "$INSTALL_LOCK_PATH" && ! -f "$INSTALL_LOCK_PATH" ) ]]; then
    echo "Refusing unsafe installer lock path: $INSTALL_LOCK_PATH" >&2
    return 1
  fi
  exec 9> "$INSTALL_LOCK_PATH" || return 1
  chown root:root "$INSTALL_LOCK_PATH" || return 1
  chmod 600 "$INSTALL_LOCK_PATH" || return 1
  read -r owner group mode < <(/usr/bin/stat -Lc '%U %G %a' -- "$INSTALL_LOCK_PATH") || return 1
  [[ "$owner" == "root" && "$group" == "root" && "$mode" == "600" ]] || return 1
  if ! flock -n 9; then
    echo "Another Nightdrop production install is already running." >&2
    return 1
  fi
}

resolve_trusted_executable() {
  local name="$1" resolved canonical current owner mode permissions parent
  resolved="$(command -v -- "$name" || true)"
  [[ -n "$resolved" ]] || return 1
  canonical="$(/usr/bin/readlink -e -- "$resolved")" || return 1
  [[ -f "$canonical" && -x "$canonical" ]] || return 1

  current="$canonical"
  while true; do
    read -r owner mode < <(/usr/bin/stat -Lc '%U %a' -- "$current") || return 1
    permissions=$((8#$mode))
    if [[ "$owner" != "root" ]] || (( (permissions & 8#022) != 0 )); then
      echo "Refusing untrusted executable or ancestor: $current" >&2
      return 1
    fi
    [[ "$current" == "/" ]] && break
    parent="$(/usr/bin/dirname -- "$current")" || return 1
    [[ "$parent" != "$current" ]] || return 1
    current="$parent"
  done
  printf '%s\n' "$canonical"
}

validate_required_commands() {
  local name
  local -a required=(
    chmod chown cp env find flock getent groupadd groupdel id install mkdir mktemp mv passwd pkill rm rmdir rsync runuser sleep test
    systemctl touch useradd userdel usermod
  )
  for name in "${required[@]}"; do
    resolve_trusted_executable "$name" >/dev/null || {
      echo "Refusing missing or untrusted required command: $name" >&2
      return 1
    }
  done
}

sync_application_tree() {
  local ownership="root:root"
  rsync -a --delete --chown="$ownership" \
    --exclude /.git/ \
    --exclude /.hermes/ \
    --exclude '/.rollback-*/' \
    --exclude '/.build-*/' \
    --exclude /node_modules/ \
    --exclude /dist/ \
    --exclude /config/ \
    --exclude /config.yaml \
    --exclude /audit.log \
    --exclude /drafts/ \
    "$SOURCE_DIR"/ "$INSTALL_DIR"/
}

snapshot_application_tree() {
  local destination="$1"
  mkdir -p "$destination"
  rsync -aAX --numeric-ids --delete \
    --exclude /.git/ \
    --exclude /.hermes/ \
    --exclude '/.rollback-*/' \
    --exclude '/.build-*/' \
    --exclude /config/ \
    --exclude /config.yaml \
    --exclude /audit.log \
    --exclude /drafts/ \
    "$INSTALL_DIR"/ "$destination"/
}

restore_application_tree() {
  local snapshot="$1" verification
  local -a restore_args=(
    -aAX --numeric-ids --delete
    --exclude '/.rollback-*/'
    --exclude '/.build-*/'
    --exclude /config/
    --exclude /config.yaml
    --exclude /audit.log
    --exclude /drafts/
  )
  rsync "${restore_args[@]}" \
    "$snapshot"/ "$INSTALL_DIR"/ || return 1
  verification="$(rsync -n --itemize-changes "${restore_args[@]}" \
    "$snapshot"/ "$INSTALL_DIR"/)" || return 1
  [[ -z "$verification" ]] || return 1
}

verify_restored_file() {
  local source="$1" destination="$2" destination_dir verification
  [[ -f "$source" && ! -L "$source" && -f "$destination" && ! -L "$destination" ]] || return 1
  [[ "${source##*/}" == "${destination##*/}" ]] || return 1
  destination_dir="$(/usr/bin/dirname -- "$destination")" || return 1
  verification="$(rsync -aAXnc --numeric-ids --itemize-changes -- \
    "$source" "$destination_dir"/)" || return 1
  [[ -z "$verification" ]]
}

wait_for_service_ready() {
  local service="$1" ready_file="$2" attempts="${3:-30}"
  local attempt main_pid restarts ready_pid="" last_pid="" last_restarts="" stable=0
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    main_pid=""
    restarts=""
    ready_pid=""
    if systemctl is-active --quiet "$service"; then
      main_pid="$(systemctl show "$service" -p MainPID --value 2>/dev/null || true)"
      restarts="$(systemctl show "$service" -p NRestarts --value 2>/dev/null || true)"
      if [[ -f "$ready_file" && ! -L "$ready_file" ]]; then
        IFS= read -r ready_pid < "$ready_file" || true
      fi
    fi

    if [[ "$main_pid" =~ ^[1-9][0-9]*$ && "$restarts" =~ ^[0-9]+$ && "$ready_pid" == "$main_pid" ]]; then
      if [[ "$main_pid" == "$last_pid" && "$restarts" == "$last_restarts" ]]; then
        stable=$((stable + 1))
      else
        stable=1
        last_pid="$main_pid"
        last_restarts="$restarts"
      fi
      if (( stable >= 3 )); then
        return 0
      fi
    else
      stable=0
      last_pid=""
      last_restarts=""
    fi
    sleep 2
  done
  return 1
}

configure_agent_audit_acl() {
  local audit_path="$1" grant="$2" agent_user="$3" setfacl_bin="$4" getfacl_bin="$5"
  local kind name permissions explicit_entry="" acl_output
  [[ -n "$setfacl_bin" && -n "$getfacl_bin" ]] || return 1
  if [[ "$grant" == true ]]; then
    "$setfacl_bin" -m "u:$agent_user:r" "$audit_path" || return 1
  else
    "$setfacl_bin" -x "u:$agent_user" "$audit_path" 2>/dev/null || true
  fi

  acl_output="$("$getfacl_bin" -cp -- "$audit_path")" || return 1
  while IFS=: read -r kind name permissions; do
    if [[ "$kind" == "user" && "$name" == "$agent_user" ]]; then
      explicit_entry="$permissions"
    fi
  done <<< "$acl_output"

  if [[ "$grant" == true ]]; then
    [[ "$explicit_entry" == "r--" ]]
  else
    [[ -z "$explicit_entry" ]]
  fi
}

snapshot_protected_metadata() {
  local path
  PREVIOUS_PROTECTED_ACL="$ROLLBACK_ROOT/protected-state.acl"
  : > "$PREVIOUS_PROTECTED_ACL" || return 1
  chmod 600 "$PREVIOUS_PROTECTED_ACL" || return 1
  for path in "${protected_paths[@]}"; do
    if [[ -e "$path" ]]; then
      PROTECTED_PATH_EXISTED["$path"]=true
      "$GETFACL_BIN" -R -p -- "$path" >> "$PREVIOUS_PROTECTED_ACL" || return 1
    else
      PROTECTED_PATH_EXISTED["$path"]=false
    fi
  done
  PROTECTED_METADATA_SNAPSHOTTED=true
}

restore_protected_metadata() {
  local path index restore_failed=false
  if [[ -n "${PREVIOUS_PROTECTED_ACL:-}" && -s "$PREVIOUS_PROTECTED_ACL" ]]; then
    "$SETFACL_BIN" --restore="$PREVIOUS_PROTECTED_ACL" || restore_failed=true
  fi
  for ((index = ${#protected_paths[@]} - 1; index >= 0; index -= 1)); do
    path="${protected_paths[$index]}"
    if [[ "${PROTECTED_PATH_EXISTED[$path]:-false}" == false && -e "$path" ]]; then
      if [[ -d "$path" ]]; then
        rmdir -- "$path" 2>/dev/null || restore_failed=true
      else
        rm -f -- "$path" || restore_failed=true
      fi
    fi
  done
  [[ "$restore_failed" == false ]]
}

validate_current_builder_group() {
  local expected_primary_user="$1" state record name password gid members
  local all_groups group_record group_name group_gid name_matches=0 gid_matches=0
  local all_passwd passwd_record passwd_name passwd_gid primary_matches=0
  state="$(nss_entry_state group "$BUILD_GROUP")" || return 1
  [[ "$state" == "present" ]] || return 1
  record="$(getent group "$BUILD_GROUP")" || return 1
  IFS=: read -r name password gid members <<< "$record"
  [[ "$name" == "$BUILD_GROUP" && "$password" == "x" && "$gid" =~ ^[1-9][0-9]*$ && -z "$members" ]] || return 1
  [[ -z "${BUILD_GID:-}" || "$gid" == "$BUILD_GID" ]] || return 1

  all_groups="$(getent group)" || return 1
  while IFS= read -r group_record; do
    IFS=: read -r group_name _ group_gid _ <<< "$group_record"
    [[ "$group_name" != "$BUILD_GROUP" ]] || name_matches=$((name_matches + 1))
    [[ "$group_gid" != "$gid" ]] || gid_matches=$((gid_matches + 1))
  done <<< "$all_groups"
  (( name_matches == 1 && gid_matches == 1 )) || return 1

  all_passwd="$(getent passwd)" || return 1
  while IFS= read -r passwd_record; do
    IFS=: read -r passwd_name _ _ passwd_gid _ <<< "$passwd_record"
    if [[ "$passwd_gid" == "$gid" ]]; then
      primary_matches=$((primary_matches + 1))
      [[ "$expected_primary_user" == present && "$passwd_name" == "$BUILD_USER" ]] || return 1
    fi
  done <<< "$all_passwd"
  if [[ "$expected_primary_user" == present ]]; then
    (( primary_matches == 1 )) || return 1
  else
    (( primary_matches == 0 )) || return 1
  fi
  VERIFIED_BUILD_GID="$gid"
}

validate_current_builder_user() {
  local state record name password uid gid _gecos home shell
  local all_passwd passwd_record passwd_name passwd_uid uid_matches=0 current_uid primary_group effective_groups
  validate_current_builder_group present || return 1
  state="$(nss_entry_state passwd "$BUILD_USER")" || return 1
  [[ "$state" == "present" ]] || return 1
  record="$(getent passwd "$BUILD_USER")" || return 1
  IFS=: read -r name password uid gid _gecos home shell <<< "$record"
  [[ "$name" == "$BUILD_USER" && "$password" == "x" && "$uid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$gid" == "$VERIFIED_BUILD_GID" && "$home" == "$BUILD_HOME" && "$shell" == "/usr/sbin/nologin" ]] || return 1
  [[ -z "${BUILD_UID:-}" || "$uid" == "$BUILD_UID" ]] || return 1

  all_passwd="$(getent passwd)" || return 1
  while IFS= read -r passwd_record; do
    IFS=: read -r passwd_name _ passwd_uid _ <<< "$passwd_record"
    if [[ "$passwd_uid" == "$uid" ]]; then
      uid_matches=$((uid_matches + 1))
      [[ "$passwd_name" == "$BUILD_USER" ]] || return 1
    fi
  done <<< "$all_passwd"
  (( uid_matches == 1 )) || return 1
  current_uid="$(id -u -- "$BUILD_USER")" || return 1
  primary_group="$(id -gn -- "$BUILD_USER")" || return 1
  effective_groups="$(id -Gn -- "$BUILD_USER")" || return 1
  [[ "$current_uid" == "$uid" && "$primary_group" == "$BUILD_GROUP" && "$effective_groups" == "$BUILD_GROUP" ]] || return 1
  VERIFIED_BUILD_UID="$uid"
}

capture_attempted_builder_group() {
  local state
  state="$(nss_entry_state group "$BUILD_GROUP")" || return 1
  [[ "$state" == "present" || "$state" == "absent" ]] || return 1
  [[ "$state" == "present" ]] || return 0
  validate_current_builder_group absent || return 1
  BUILD_GID="$VERIFIED_BUILD_GID"
  BUILD_GROUP_CREATED=true
}

capture_attempted_builder_user() {
  local state
  state="$(nss_entry_state passwd "$BUILD_USER")" || return 1
  [[ "$state" == "present" || "$state" == "absent" ]] || return 1
  [[ "$state" == "present" ]] || return 0
  validate_current_builder_user || return 1
  BUILD_UID="$VERIFIED_BUILD_UID"
  BUILD_USER_CREATED=true
}

create_builder_identity() {
  if ! groupadd -r "$BUILD_GROUP"; then
    capture_attempted_builder_group || BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=true
    echo "Transient build group creation failed; refusing deployment." >&2
    return 1
  fi
  if ! capture_attempted_builder_group || [[ "$BUILD_GROUP_CREATED" != true ]]; then
    BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=true
    echo "Transient build group creation could not be proven; refusing deployment." >&2
    return 1
  fi
  if ! useradd -r -M -g "$BUILD_GROUP" -d "$BUILD_HOME" -s /usr/sbin/nologin "$BUILD_USER"; then
    capture_attempted_builder_user || BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=true
    echo "Transient build user creation failed; refusing deployment." >&2
    return 1
  fi
  if ! capture_attempted_builder_user || [[ "$BUILD_USER_CREATED" != true ]]; then
    BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=true
    echo "Transient build user creation could not be proven; refusing deployment." >&2
    return 1
  fi
}

stop_previous_service() {
  if [[ "$SERVICE_WAS_ACTIVE" == true ]]; then
    SERVICE_STOPPED=true
    systemctl stop "$SERVICE_NAME"
  fi
}

cleanup_builder_identity() {
  local state
  [[ "${BUILD_IDENTITY_OWNERSHIP_UNCERTAIN:-false}" == false ]] || return 1

  if [[ "${BUILD_USER_CREATED:-false}" == true ]]; then
    state="$(nss_entry_state passwd "$BUILD_USER")" || return 1
    if [[ "$state" == "absent" ]]; then
      BUILD_USER_CREATED=false
      BUILD_UID=""
    elif [[ "$state" == "present" ]]; then
      validate_current_builder_user || return 1
      [[ "$VERIFIED_BUILD_UID" == "$BUILD_UID" ]] || return 1
      pkill -KILL -u "$BUILD_UID" >/dev/null 2>&1 || true
      userdel "$BUILD_USER" >/dev/null 2>&1 || return 1
      state="$(nss_entry_state passwd "$BUILD_USER")" || return 1
      [[ "$state" == "absent" ]] || return 1
      BUILD_USER_CREATED=false
      BUILD_UID=""
    else
      return 1
    fi
  fi

  [[ "${BUILD_USER_CREATED:-false}" == false ]] || return 1
  if [[ "${BUILD_GROUP_CREATED:-false}" == true ]]; then
    state="$(nss_entry_state group "$BUILD_GROUP")" || return 1
    if [[ "$state" == "absent" ]]; then
      BUILD_GROUP_CREATED=false
      BUILD_GID=""
    elif [[ "$state" == "present" ]]; then
      validate_current_builder_group absent || return 1
      [[ "$VERIFIED_BUILD_GID" == "$BUILD_GID" ]] || return 1
      groupdel "$BUILD_GROUP" >/dev/null 2>&1 || return 1
      state="$(nss_entry_state group "$BUILD_GROUP")" || return 1
      [[ "$state" == "absent" ]] || return 1
      BUILD_GROUP_CREATED=false
      BUILD_GID=""
    else
      return 1
    fi
  fi
}

cleanup_builder() {
  local cleanup_failed=false
  cleanup_builder_identity || cleanup_failed=true
  if [[ -n "${BUILD_HOME:-}" ]]; then
    rm -rf -- "$BUILD_HOME" || cleanup_failed=true
  fi
  if [[ -n "${BUILD_ROOT:-}" ]]; then
    rm -rf -- "$BUILD_ROOT" || cleanup_failed=true
  fi
  if [[ -n "${MAILBOX_CLI_TEMP:-}" ]]; then
    rm -f -- "$MAILBOX_CLI_TEMP" || cleanup_failed=true
  fi
  BUILD_HOME=""
  BUILD_ROOT=""
  MAILBOX_CLI_TEMP=""
  [[ "$cleanup_failed" == false ]]
}

restore_service_enablement() {
  local state status
  if [[ "$SERVICE_ENABLEMENT_STATE" == "enabled" ]]; then
    systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || return 1
    state="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null)" || return 1
    [[ "$state" == "enabled" ]] || return 1
    return 0
  fi

  systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  if state="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null)"; then
    return 1
  else
    status=$?
  fi
  [[ "$status:$state" == "1:disabled" || "$status:$state" == "4:not-found" ]] || return 1
  [[ "$state" == "$SERVICE_ENABLEMENT_STATE" ]] || return 1
}

perform_deployment_rollback() {
  local status="$1" rollback_failed=false
  if [[ "$status" -ne 0 ]]; then
    if [[ "$SERVICE_STOPPED" == true || "$APP_TREE_SYNCED" == true || "$UNIT_WRITTEN" == true ]]; then
      systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || rollback_failed=true
    fi
    if [[ "$APP_TREE_SYNCED" == true && -n "$PREVIOUS_APP_TREE" && -d "$PREVIOUS_APP_TREE" ]]; then
      restore_application_tree "$PREVIOUS_APP_TREE" || rollback_failed=true
    fi
    if [[ "$CONFIG_TOUCHED" == true ]]; then
      rm -f -- "$CONFIG_DIR/config.yaml" "$INSTALL_DIR/config.yaml" || rollback_failed=true
      if [[ -n "$PREVIOUS_CONFIG" && -e "$PREVIOUS_CONFIG" ]]; then
        cp -a "$PREVIOUS_CONFIG" "$CONFIG_DIR/config.yaml" || rollback_failed=true
      fi
      if [[ -n "$PREVIOUS_LEGACY_CONFIG" && -e "$PREVIOUS_LEGACY_CONFIG" ]]; then
        cp -a "$PREVIOUS_LEGACY_CONFIG" "$INSTALL_DIR/config.yaml" || rollback_failed=true
      fi
    fi
    if [[ "$UNIT_WRITTEN" == true ]]; then
      if [[ -n "$PREVIOUS_UNIT" && -e "$PREVIOUS_UNIT" ]]; then
        cp -a "$PREVIOUS_UNIT" "$UNIT_PATH" || rollback_failed=true
      else
        rm -f -- "$UNIT_PATH" || rollback_failed=true
      fi
    fi
    if [[ "$MAILBOX_CLI_TOUCHED" == true ]]; then
      if [[ "$MAILBOX_CLI_EXISTED" == true && -n "$PREVIOUS_MAILBOX_CLI" && -f "$PREVIOUS_MAILBOX_CLI" ]]; then
        rm -f -- "$MAILBOX_CLI_PATH" || rollback_failed=true
        if cp -a "$PREVIOUS_MAILBOX_CLI" "$MAILBOX_CLI_PATH"; then
          verify_restored_file "$PREVIOUS_MAILBOX_CLI" "$MAILBOX_CLI_PATH" || rollback_failed=true
        else
          rollback_failed=true
        fi
      else
        rm -f -- "$MAILBOX_CLI_PATH" || rollback_failed=true
      fi
    fi
    if [[ "$PROTECTED_METADATA_SNAPSHOTTED" == true ]]; then
      restore_protected_metadata || rollback_failed=true
    fi
    if [[ "$UNIT_WRITTEN" == true ]]; then
      systemctl daemon-reload >/dev/null 2>&1 || rollback_failed=true
    fi
    if [[ "$UNIT_ENABLEMENT_TOUCHED" == true ]]; then
      restore_service_enablement || rollback_failed=true
    fi
    if [[ "$SERVICE_WAS_ACTIVE" == true && ( "$SERVICE_STOPPED" == true || "$APP_TREE_SYNCED" == true || "$UNIT_WRITTEN" == true ) ]]; then
      if systemctl start "$SERVICE_NAME" >/dev/null 2>&1; then
        wait_for_service_ready "$SERVICE_NAME" "$READY_FILE" 30 || rollback_failed=true
      else
        rollback_failed=true
      fi
    fi
  fi
  cleanup_builder || rollback_failed=true

  if [[ "$rollback_failed" == true ]]; then
    echo "Nightdrop rollback was incomplete; recovery material retained at ${ROLLBACK_ROOT:-unavailable}." >&2
    return 1
  fi
  if [[ -n "$ROLLBACK_ROOT" ]]; then
    if ! rm -rf -- "$ROLLBACK_ROOT"; then
      echo "Could not remove the completed rollback snapshot: $ROLLBACK_ROOT" >&2
      return 1
    fi
    ROLLBACK_ROOT=""
  fi
}

main() {
local option
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-user|--deployment-profile|--telegram-user-id|--install-dir)
      option="$1"
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $option" >&2
        usage
        exit 2
      fi
      case "$option" in
        --agent-user) AGENT_USER="$2" ;;
        --deployment-profile) DEPLOYMENT_PROFILE="$2" ;;
        --telegram-user-id) TELEGRAM_USER_ID="$2" ;;
        --install-dir) INSTALL_DIR="$2" ;;
      esac
      shift 2
      ;;
    --acknowledge-agent-host-admin-risk) ACKNOWLEDGE_AGENT_HOST_ADMIN_RISK=true; shift ;;
    --grant-agent-audit-read) GRANT_AGENT_AUDIT_READ=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi
validate_trusted_path || exit 1
validate_required_commands || exit 1
if ! validate_telegram_user_id "$TELEGRAM_USER_ID"; then
  echo "--telegram-user-id must be a positive decimal integer within JavaScript's safe range." >&2
  exit 2
fi
if ! validate_deployment_profile "$DEPLOYMENT_PROFILE"; then
  echo "--deployment-profile must be standard or strict." >&2
  exit 2
fi
if [[ "$DEPLOYMENT_PROFILE" == strict && "$ACKNOWLEDGE_AGENT_HOST_ADMIN_RISK" == true ]]; then
  echo "--acknowledge-agent-host-admin-risk is valid only with --deployment-profile standard." >&2
  exit 2
fi
if ! validate_agent_identity "$AGENT_USER"; then
  echo "--agent-user must name an existing non-root account with a nonzero UID, distinct from the Nightdrop service user." >&2
  exit 2
fi
if ! validate_install_dir "$INSTALL_DIR"; then
  echo "--install-dir must be a canonical absolute path below /opt using safe path characters." >&2
  exit 2
fi
if ! validate_root_owned_directory_chain "$INSTALL_DIR" true; then
  echo "--install-dir and every existing ancestor must be root-owned, non-writable by group/other, and traversable." >&2
  exit 1
fi
acquire_install_lock || exit 1
AGENT_UID_SNAPSHOT="$(capture_agent_identity_snapshot)" || {
  echo "Selected agent identity changed or became ambiguous before the install lock was established." >&2
  exit 1
}
if ! validate_agent_group_boundary_preflight; then
  if [[ "$DEPLOYMENT_PROFILE" == strict ]]; then
    echo "Strict mode requires --agent-user to have only its same-named private primary group and the two Nightdrop capability groups." >&2
  else
    echo "Standard mode requires a stable primary group, no Nightdrop private-group membership, and either zero or both Nightdrop capability groups." >&2
  fi
  exit 2
fi
PRIVILEGED_AGENT_RISK=false
if detect_agent_privilege_risk; then
  PRIVILEGED_AGENT_RISK=true
else
  privilege_detection_status=$?
  if [[ "$privilege_detection_status" -ne 1 ]]; then
    echo "Could not determine whether --agent-user has direct host-administration capability." >&2
    exit 1
  fi
fi
if ! validate_privileged_agent_acknowledgment \
  "$DEPLOYMENT_PROFILE" "$PRIVILEGED_AGENT_RISK" "$ACKNOWLEDGE_AGENT_HOST_ADMIN_RISK"; then
  if [[ "$DEPLOYMENT_PROFILE" == strict ]]; then
    echo "Strict mode refuses an agent identity with host-administration capability indicators." >&2
  else
    echo "Standard mode detected host-administration capability indicators. Re-run with --acknowledge-agent-host-admin-risk only if you accept that same-host isolation is not a hard boundary against that agent." >&2
  fi
  exit 2
fi
if [[ "$PRIVILEGED_AGENT_RISK" == true ]]; then
  echo "WARNING: privileged agent acknowledged; Nightdrop still gates normal workflows, but same-host credentials are not structurally isolated from this agent." >&2
  echo "Detected indicators: $AGENT_PRIVILEGE_RISK_DETAILS" >&2
fi
if [[ -L "$MAILBOX_CLI_PATH" || ( -e "$MAILBOX_CLI_PATH" && ! -f "$MAILBOX_CLI_PATH" ) ]]; then
  echo "Refusing unsafe existing mailbox client path: $MAILBOX_CLI_PATH" >&2
  exit 1
fi

if ! validate_trusted_source_tree; then
  echo "Installer source and every ancestor must be a root-owned, non-group/world-writable tree without active symlinks." >&2
  exit 1
fi
if [[ ! -f "$SOURCE_DIR/package.json" || ! -f "$SOURCE_DIR/package-lock.json" || ! -d "$SOURCE_DIR/src" ]]; then
  echo "Installer source is not a complete Nightdrop checkout: $SOURCE_DIR" >&2
  exit 1
fi
source_symlink="$(find "$SOURCE_DIR" \
  \( -path "$SOURCE_DIR/.git" -o -path "$SOURCE_DIR/node_modules" -o -path "$SOURCE_DIR/dist" \) -prune -o \
  -type l -print -quit)"
if [[ -n "$source_symlink" ]]; then
  echo "Installer source contains an unsupported symbolic link: $source_symlink" >&2
  exit 1
fi
if [[ "$INSTALL_DIR" == "$SOURCE_DIR" ]]; then
  echo "Run the installer from a separate reviewed checkout, not from the live install tree." >&2
  exit 2
fi

if ! NODE_BIN="$(resolve_trusted_executable node)" \
  || ! NPM_BIN="$(resolve_trusted_executable npm)" \
  || ! PASS_BIN="$(resolve_trusted_executable pass)" \
  || ! ENV_BIN="$(resolve_trusted_executable env)"; then
  echo "Trusted root-owned node, npm, pass, and env executables are required on the fixed system PATH." >&2
  exit 1
fi
SETFACL_BIN="$(resolve_trusted_executable setfacl || true)"
GETFACL_BIN="$(resolve_trusted_executable getfacl || true)"
if [[ -z "$SETFACL_BIN" || -z "$GETFACL_BIN" ]]; then
  echo "Trusted setfacl and getfacl executables are required to enforce the audit boundary." >&2
  exit 1
fi
NODE_MAJOR="$("$ENV_BIN" -i PATH="$TRUSTED_PATH" LANG=C LC_ALL=C \
  "$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  echo "Nightdrop requires a supported Node.js 22 or newer runtime." >&2
  exit 1
fi

prepare_nightdrop_identities
SERVICE_GROUP="$SERVICE_USER"
MAILBOX_GROUP_RECORD="$(getent group "$MAILBOX_GROUP")"
IFS=: read -r _ _ MAILBOX_GROUP_GID _ <<< "$MAILBOX_GROUP_RECORD"
if [[ ! "$MAILBOX_GROUP_GID" =~ ^[1-9][0-9]*$ ]]; then
  echo "Could not resolve the mailbox capability group ID." >&2
  exit 1
fi
CONFIG_DIR="$INSTALL_DIR/config"
BUILD_USER="nightdrop-build-$$"
BUILD_USER_CREATED=false
BUILD_GROUP="$BUILD_USER"
BUILD_GROUP_CREATED=false
BUILD_IDENTITY_OWNERSHIP_UNCERTAIN=false
BUILD_UID=""
BUILD_GID=""
VERIFIED_BUILD_UID=""
VERIFIED_BUILD_GID=""
BUILD_HOME=""
BUILD_ROOT=""
ROLLBACK_ROOT=""
PREVIOUS_APP_TREE=""
PREVIOUS_DIST=""
PREVIOUS_MODULES=""
PREVIOUS_CONFIG=""
PREVIOUS_LEGACY_CONFIG=""
PREVIOUS_UNIT=""
PREVIOUS_MAILBOX_CLI=""
PREVIOUS_PROTECTED_ACL=""
PROTECTED_METADATA_SNAPSHOTTED=false
MAILBOX_CLI_EXISTED=false
MAILBOX_CLI_TOUCHED=false
MAILBOX_CLI_TEMP=""
APP_TREE_SYNCED=false
CONFIG_TOUCHED=false
UNIT_WRITTEN=false
SERVICE_WAS_ACTIVE=false
SERVICE_STOPPED=false
UNIT_ENABLEMENT_TOUCHED=false
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME"
READY_FILE="/run/nightdrop/ready"
declare -A PROTECTED_PATH_EXISTED=()

if systemctl is-active --quiet "$SERVICE_NAME"; then
  SERVICE_WAS_ACTIVE=true
fi
if SERVICE_ENABLEMENT_STATE="$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null)"; then
  [[ "$SERVICE_ENABLEMENT_STATE" == "enabled" ]] || {
    echo "Unsupported prior systemd enablement state for $SERVICE_NAME: $SERVICE_ENABLEMENT_STATE" >&2
    exit 1
  }
else
  SERVICE_ENABLEMENT_STATUS=$?
  case "$SERVICE_ENABLEMENT_STATUS:$SERVICE_ENABLEMENT_STATE" in
    1:disabled|4:not-found) ;;
    *)
      echo "Could not establish the prior systemd enablement state for $SERVICE_NAME." >&2
      exit 1
      ;;
  esac
fi

restore_previous_deployment() {
  local status="${1-$?}"
  trap - EXIT
  cleanup_agent_access_probe || status=1
  if ! perform_deployment_rollback "$status"; then
    [[ "$status" -ne 0 ]] || status=1
  fi
  exit "$status"
}
trap restore_previous_deployment EXIT

if [[ -L "$INSTALL_DIR" ]]; then
  echo "Refusing symbolic link at protected install path: $INSTALL_DIR" >&2
  exit 1
fi
if [[ ! -d "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR"
  chown root:root "$INSTALL_DIR"
  chmod 711 "$INSTALL_DIR"
fi
validate_root_owned_directory_chain "$INSTALL_DIR" true || exit 1
protected_paths=(
  "$CONFIG_DIR"
  "$CONFIG_DIR/config.yaml"
  "$INSTALL_DIR/config.yaml"
  "$INSTALL_DIR/drafts"
  "$INSTALL_DIR/drafts/inbox"
  "$INSTALL_DIR/drafts/pending"
  "$INSTALL_DIR/drafts/approved"
  "$INSTALL_DIR/drafts/sent"
  "$INSTALL_DIR/drafts/denied"
  "$INSTALL_DIR/drafts/failed"
  "$INSTALL_DIR/audit.log"
  "$MAILBOX_CLI_PATH"
)
for protected_path in "${protected_paths[@]}"; do
  if [[ -L "$protected_path" ]]; then
    echo "Refusing symbolic link at protected install path: $protected_path" >&2
    exit 1
  fi
done

ROLLBACK_ROOT="$(mktemp -d "$INSTALL_DIR/.rollback-XXXXXXXX")"
chmod 700 "$ROLLBACK_ROOT"
snapshot_protected_metadata || {
  echo "Could not snapshot protected path ownership, modes, and ACLs." >&2
  exit 1
}
if [[ -f "$CONFIG_DIR/config.yaml" ]]; then
  PREVIOUS_CONFIG="$ROLLBACK_ROOT/config.yaml"
  cp -a "$CONFIG_DIR/config.yaml" "$PREVIOUS_CONFIG"
fi
if [[ -f "$INSTALL_DIR/config.yaml" ]]; then
  PREVIOUS_LEGACY_CONFIG="$ROLLBACK_ROOT/legacy-config.yaml"
  cp -a "$INSTALL_DIR/config.yaml" "$PREVIOUS_LEGACY_CONFIG"
fi
if [[ -f "$UNIT_PATH" ]]; then
  PREVIOUS_UNIT="$ROLLBACK_ROOT/nightdrop.service"
  cp -a "$UNIT_PATH" "$PREVIOUS_UNIT"
fi
if [[ -f "$MAILBOX_CLI_PATH" ]]; then
  MAILBOX_CLI_EXISTED=true
  PREVIOUS_MAILBOX_CLI="$ROLLBACK_ROOT/nightdrop-mailbox"
  cp -a "$MAILBOX_CLI_PATH" "$PREVIOUS_MAILBOX_CLI"
  verify_restored_file "$MAILBOX_CLI_PATH" "$PREVIOUS_MAILBOX_CLI" || {
    echo "Could not verify the mailbox client rollback snapshot." >&2
    exit 1
  }
fi
PREVIOUS_DIST="$ROLLBACK_ROOT/previous-dist"
PREVIOUS_MODULES="$ROLLBACK_ROOT/previous-node-modules"
PREVIOUS_APP_TREE="$ROLLBACK_ROOT/application-tree"
snapshot_application_tree "$PREVIOUS_APP_TREE"

mkdir -p "$CONFIG_DIR" "$INSTALL_DIR"/drafts/{inbox,pending,approved,sent,denied,failed}

# Build a complete replacement runtime outside the live dist/node_modules while
# lifecycle hooks stay disabled as root; TypeScript compilation runs as a
# one-use account with no access to nightdrop's config or credential store.
BUILD_ROOT="$(mktemp -d "$INSTALL_DIR/.build-XXXXXXXX")"
BUILD_HOME="$(mktemp -d /tmp/nightdrop-build-home.XXXXXXXX)"
install -m 0644 \
  "$SOURCE_DIR/package.json" \
  "$SOURCE_DIR/package-lock.json" \
  "$SOURCE_DIR/tsconfig.json" \
  "$BUILD_ROOT/"
cp -a "$SOURCE_DIR/src" "$BUILD_ROOT/src"
"$ENV_BIN" -i \
  HOME=/root \
  PATH="$TRUSTED_PATH" \
  LANG=C \
  LC_ALL=C \
  "$NPM_BIN" ci --ignore-scripts --prefix "$BUILD_ROOT"

BUILD_USER_STATE="$(nss_entry_state passwd "$BUILD_USER")" || exit 1
BUILD_GROUP_STATE="$(nss_entry_state group "$BUILD_GROUP")" || exit 1
if [[ "$BUILD_USER_STATE" != "absent" || "$BUILD_GROUP_STATE" != "absent" ]]; then
  echo "Refusing pre-existing transient build identity: $BUILD_USER" >&2
  exit 1
fi
create_builder_identity || exit 1
BUILD_UID="$(id -u -- "$BUILD_USER")" || exit 1
[[ "$BUILD_UID" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$(id -gn "$BUILD_USER")" == "$BUILD_GROUP" ]] || exit 1
[[ "$(nss_entry_state passwd "$BUILD_USER")" == "present" ]] || exit 1
[[ "$(nss_entry_state group "$BUILD_GROUP")" == "present" ]] || exit 1
chown root:"$BUILD_GROUP" "$BUILD_ROOT"
chmod 750 "$BUILD_ROOT"
chown -hR root:"$BUILD_GROUP" \
  "$BUILD_ROOT/package.json" \
  "$BUILD_ROOT/package-lock.json" \
  "$BUILD_ROOT/tsconfig.json" \
  "$BUILD_ROOT/src" \
  "$BUILD_ROOT/node_modules"
chmod -R u=rwX,g=rX,o= \
  "$BUILD_ROOT/package.json" \
  "$BUILD_ROOT/package-lock.json" \
  "$BUILD_ROOT/tsconfig.json" \
  "$BUILD_ROOT/src" \
  "$BUILD_ROOT/node_modules"
install -d -o "$BUILD_USER" -g "$BUILD_GROUP" -m 700 "$BUILD_ROOT/dist"
chown "$BUILD_USER:$BUILD_GROUP" "$BUILD_HOME"
chmod 700 "$BUILD_HOME"
runuser -u "$BUILD_USER" -- env -i \
  HOME="$BUILD_HOME" \
  PATH="$TRUSTED_PATH" \
  "$NPM_BIN" --prefix "$BUILD_ROOT" run build
cleanup_builder_identity || {
  echo "Transient build identity cleanup was incomplete; refusing deployment." >&2
  exit 1
}

build_symlink="$(find "$BUILD_ROOT/dist" -type l -print -quit)"
if [[ -n "$build_symlink" ]]; then
  echo "Refusing symbolic link in compiled runtime: $build_symlink" >&2
  exit 1
fi
chown -hR root:"$SERVICE_GROUP" "$BUILD_ROOT/dist" "$BUILD_ROOT/node_modules"
chmod -R u=rwX,g=rX,o= "$BUILD_ROOT/dist" "$BUILD_ROOT/node_modules"

# Keep the live service running during network installation and compilation. The
# outage begins only after the candidate runtime has built and passed structural checks.
stop_previous_service

APP_TREE_SYNCED=true
sync_application_tree

# rsync applies root ownership only to copied application code. Excluded config,
# runtime state, and the previous dist/node_modules retain their existing owners
# until the candidate runtime is swapped in.
chmod 711 "$INSTALL_DIR"
chown root:root "$INSTALL_DIR/scripts"
chmod 755 "$INSTALL_DIR/scripts"
chown root:root \
  "$INSTALL_DIR/scripts/oauth-setup.sh" \
  "$INSTALL_DIR/scripts/smtp-setup.sh" \
  "$INSTALL_DIR/scripts/mailbox-cleanup.sh" \
  "$INSTALL_DIR/scripts/configure-provider-secrets.sh" \
  "$INSTALL_DIR/scripts/install-production.sh"
chmod 755 \
  "$INSTALL_DIR/scripts/oauth-setup.sh" \
  "$INSTALL_DIR/scripts/smtp-setup.sh" \
  "$INSTALL_DIR/scripts/mailbox-cleanup.sh" \
  "$INSTALL_DIR/scripts/configure-provider-secrets.sh" \
  "$INSTALL_DIR/scripts/install-production.sh"

[[ ! -e "$INSTALL_DIR/dist" ]] || mv "$INSTALL_DIR/dist" "$PREVIOUS_DIST"
[[ ! -e "$INSTALL_DIR/node_modules" ]] || mv "$INSTALL_DIR/node_modules" "$PREVIOUS_MODULES"
mv "$BUILD_ROOT/node_modules" "$INSTALL_DIR/node_modules"
mv "$BUILD_ROOT/dist" "$INSTALL_DIR/dist"
cleanup_builder

chown -hR root:root "$INSTALL_DIR/src"
chmod -R u=rwX,go= "$INSTALL_DIR/src"

# Migrate the legacy single-file location once. The dedicated directory is the
# only app-tree location writable by nightdrop, which preserves atomic renames
# without making the root-owned scripts replaceable.
CONFIG_TOUCHED=true
mkdir -p "$CONFIG_DIR"
if [[ -f "$INSTALL_DIR/config.yaml" ]]; then
  if [[ -e "$CONFIG_DIR/config.yaml" ]]; then
    echo "Both legacy and current config paths exist; refusing ambiguous migration." >&2
    exit 1
  fi
  mv "$INSTALL_DIR/config.yaml" "$CONFIG_DIR/config.yaml"
fi
if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
  /usr/bin/cat > "$CONFIG_DIR/config.yaml" <<EOF
telegram:
  botToken: "\${PASS:nightdrop/telegram-bot-token}"
  allowedUsers: [$TELEGRAM_USER_ID]

watch:
  directory: "$INSTALL_DIR/drafts/inbox"
  pollIntervalMs: 2000

approval:
  bodyPreviewChars: 2000
  allowTruncatedApproval: false

security:
  enforceProductionPermissions: true

providers:
  log:
    type: "log-only"
    fromAddress: "log-only@example.invalid"

defaults:
  provider: "log"
  timezone: "UTC"
  autoDeleteAfterDays: 30

audit:
  enabled: true
  logFile: "$INSTALL_DIR/audit.log"
EOF
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
chmod 600 "$CONFIG_DIR/config.yaml"

chown "root:$SERVICE_GROUP" "$INSTALL_DIR/drafts"
chmod 711 "$INSTALL_DIR/drafts"
chown "$SERVICE_USER:$INBOX_GROUP" "$INSTALL_DIR/drafts/inbox"
chmod 1730 "$INSTALL_DIR/drafts/inbox"
for dir in pending approved sent denied failed; do
  chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/drafts/$dir"
  chmod 700 "$INSTALL_DIR/drafts/$dir"
done

touch "$INSTALL_DIR/audit.log"
chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/audit.log"
chmod 640 "$INSTALL_DIR/audit.log"
if ! configure_agent_audit_acl \
  "$INSTALL_DIR/audit.log" \
  "$GRANT_AGENT_AUDIT_READ" \
  "$AGENT_USER" \
  "$SETFACL_BIN" \
  "$GETFACL_BIN"; then
  echo "Could not enforce the requested agent audit-log ACL policy." >&2
  exit 1
fi
if ! verify_agent_access_boundary; then
  echo "Agent filesystem access failed the behavioral write-only/private-state boundary probe." >&2
  exit 1
fi

UNIT_WRITTEN=true
/usr/bin/cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Nightdrop — Deterministic Approval Layer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
SupplementaryGroups=$INBOX_GROUP $MAILBOX_GROUP
RuntimeDirectory=nightdrop nightdrop-mailbox
RuntimeDirectoryMode=0711
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
Environment=NIGHTDROP_CONFIG=$CONFIG_DIR/config.yaml
Environment=NIGHTDROP_READY_FILE=$READY_FILE
Environment=NIGHTDROP_MAILBOX_SOCKET=/run/nightdrop-mailbox/broker.sock
Environment=NIGHTDROP_MAILBOX_GID=$MAILBOX_GROUP_GID
Environment=NIGHTDROP_PASS_BIN=$PASS_BIN
Environment=PASSWORD_STORE_DIR=/home/$SERVICE_USER/.password-store
Environment=GNUPGHOME=/home/$SERVICE_USER/.gnupg
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
PrivateDevices=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
SystemCallArchitectures=native
ReadWritePaths=$INSTALL_DIR/drafts $INSTALL_DIR/audit.log /home/$SERVICE_USER/.gnupg /home/$SERVICE_USER/.password-store
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nightdrop

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
UNIT_ENABLEMENT_TOUCHED=true
systemctl enable "$SERVICE_NAME" >/dev/null
if [[ "$SERVICE_WAS_ACTIVE" == true ]]; then
  systemctl start "$SERVICE_NAME"
  if ! wait_for_service_ready "$SERVICE_NAME" "$READY_FILE" 30; then
    echo "Upgraded service failed PID-bound readiness and restart-stability checks; restoring the previous deployment." >&2
    exit 1
  fi
fi
MAILBOX_CLI_TEMP="$MAILBOX_CLI_PATH.new.$$"
install -o root -g root -m 0755 "$INSTALL_DIR/dist/mailbox-client.js" "$MAILBOX_CLI_TEMP"
MAILBOX_CLI_TOUCHED=true
mv -T -- "$MAILBOX_CLI_TEMP" "$MAILBOX_CLI_PATH"
MAILBOX_CLI_TEMP=""
if [[ -L "$MAILBOX_CLI_PATH" || ! -f "$MAILBOX_CLI_PATH" || "$(/usr/bin/stat -c '%U:%G:%a' "$MAILBOX_CLI_PATH")" != "root:root:755" ]]; then
  echo "Installed mailbox client failed ownership/mode verification." >&2
  exit 1
fi
if [[ "$SERVICE_WAS_ACTIVE" == true ]]; then
  MAILBOX_SOCKET_PATH="/run/nightdrop-mailbox/broker.sock"
  if [[ ! -S "$MAILBOX_SOCKET_PATH" || "$(/usr/bin/stat -c '%U:%G:%a' "$MAILBOX_SOCKET_PATH")" != "$SERVICE_USER:$MAILBOX_GROUP:660" ]]; then
    echo "Mailbox broker socket failed ownership/mode verification." >&2
    exit 1
  fi
fi
rm -rf -- "$ROLLBACK_ROOT"
ROLLBACK_ROOT=""
trap - EXIT

/usr/bin/cat <<DONE
Installed Nightdrop to $INSTALL_DIR.
Private config: $CONFIG_DIR/config.yaml

Next steps:
1. Configure secrets for the $SERVICE_USER user, or keep provider=log for dry-run.
2. Start: sudo systemctl start $SERVICE_NAME
3. Verify: sudo journalctl -u $SERVICE_NAME -n 50 --no-pager
4. Re-login $AGENT_USER so membership in $INBOX_GROUP and $MAILBOX_GROUP is active.

Hermes/agent paths:
  Draft dropbox: $INSTALL_DIR/drafts/inbox
  Mailbox client: $MAILBOX_CLI_PATH
DONE
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
