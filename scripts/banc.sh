#!/bin/sh
# Banc d'essai : un conteneur qui tient lieu de VPS. Le jalon 3b écrit sur des machines ;
# aucune tâche ne se clôt sans que son script ait tourné ici pour de vrai.
#
# Hors du paquet npm : `files` ne publie que `dist`, `README.md` et `LICENSE`. Ce script est
# un outil de développement, il n'a rien à faire chez un client.
#
# Usage :
#   scripts/banc.sh up [--with-docker]   monte le banc et rend de quoi s'y connecter
#   scripts/banc.sh ssh [--with-docker] [commande…]   ouvre une session sur le banc courant
#   scripts/banc.sh down                 démonte tout, y compris la clé jetable
#   scripts/banc.sh status               dit ce qui tourne
set -eu

# Ubuntu 24.04, la même famille que les VPS visés : un banc sur Alpine ferait passer pour
# valides des scripts qui échoueraient chez le client — `apt-get` absent, `dash` remplacé
# par `busybox ash`, chemins différents.
BASE_IMAGE="ubuntu:24.04"

# Noms déterministes : un banc oublié est réutilisé ou démonté, jamais accumulé en dizaines
# de conteneurs anonymes.
NAME_PLAIN="skynode-banc"
NAME_DOCKER="skynode-banc-docker"
IMAGE_PLAIN="skynode-banc:plain"
IMAGE_DOCKER="skynode-banc:docker"
# Docker-dans-Docker a besoin d'un vrai système de fichiers pour son entrepôt d'images :
# empilé sur l'overlay du conteneur, `dockerd` refuse de démarrer ou retombe sur `vfs`.
VOLUME_DOCKER="skynode-banc-docker-lib"

# La clé est jetable mais son chemin est stable : `ssh` et `down` doivent la retrouver sans
# qu'on la leur passe, et `up` la régénère à chaque montage.
BANC_DIR="${SKYNODE_BANC_DIR:-${TMPDIR:-/tmp}/skynode-banc}"

# Le banc n'écoute que sur la boucle locale : il porte une clé sans phrase de passe et
# autorise root, ce qui n'a rien à faire sur une interface exposée.
BIND_ADDR="127.0.0.1"

# Options de connexion : l'hôte est neuf à chaque montage et sa clé d'hôte change avec
# l'image, donc pas de `known_hosts` à tenir. `IdentitiesOnly` évite qu'un agent SSH chargé
# de dix clés épuise les tentatives avant d'arriver à la nôtre.
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes"

mode_name() { if [ "$1" = "docker" ]; then echo "$NAME_DOCKER"; else echo "$NAME_PLAIN"; fi; }
mode_image() { if [ "$1" = "docker" ]; then echo "$IMAGE_DOCKER"; else echo "$IMAGE_PLAIN"; fi; }
# Une clé par mode, pas une pour les deux : les deux bancs peuvent tourner en même temps, et
# une clé commune régénérée par le second montage enfermerait le premier dehors — son
# `authorized_keys` porte encore l'ancienne, et rien ne dit pourquoi la connexion est refusée.
mode_key() { echo "$BANC_DIR/$(mode_name "$1")/id_ed25519"; }

# Tout ce que le banc dit de lui-même part sur stdout, en `clé<TAB>valeur` comme le reste du
# projet : un script appelant lit une valeur sans avoir à découper une phrase.
emit() { printf '%s\t%s\n' "$1" "$2"; }
# Le reste — progression, diagnostic — part sur stderr, pour ne pas se mêler aux valeurs.
log() { printf '%s\n' "$*" >&2; }
die() { printf '%s\n' "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker est introuvable : le banc en a besoin."
  docker info >/dev/null 2>&1 || die "le démon Docker ne répond pas."
}

# Construction locale plutôt qu'une image toute faite tirée d'un registre : le banc sert à
# éprouver du code qui écrit en root, et ce qu'il contient doit se lire ici, en entier.
build_image() {
  mode="$1"
  image=$(mode_image "$mode")

  if [ "$mode" = "docker" ]; then
    extra="RUN apt-get update && apt-get install -y --no-install-recommends docker.io docker-compose-v2 && rm -rf /var/lib/apt/lists/*"
  else
    extra="RUN true"
  fi

  log "→ construction de $image (mise en cache par Docker, instantanée aux montages suivants)"
  docker build -q -t "$image" - >/dev/null <<DOCKERFILE
FROM $BASE_IMAGE
ENV DEBIAN_FRONTEND=noninteractive
# iproute2 pour \`ss\`, dont la sonde du jalon 2 se sert ; ca-certificates et curl parce que
# l'installation de Docker par le script de la tâche 3 en dépendra.
RUN apt-get update && apt-get install -y --no-install-recommends \\
      openssh-server iproute2 ca-certificates curl sudo \\
    && rm -rf /var/lib/apt/lists/*
$extra
RUN ssh-keygen -A && mkdir -p /run/sshd
# 99- et non 00- : \`sshd\` retient la première valeur rencontrée, et le durcissement de la
# tâche 4 écrit dans 50-skynode.conf. Un fichier du banc trié avant le sien le rendrait
# inopérant, et la tâche se croirait vérifiée alors qu'elle ne le serait pas.
RUN printf '%s\\n' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' \\
    > /etc/ssh/sshd_config.d/99-banc.conf
DOCKERFILE
}

# La clé ne sert qu'au banc et ne survit pas à `down` : elle n'a ni phrase de passe ni raison
# d'être conservée. Régénérée à chaque montage — une clé réutilisée d'un banc à l'autre
# finirait par traîner dans un `authorized_keys` qu'on croit propre.
make_key() {
  key="$1"
  dir=$(dirname "$key")
  rm -rf "$dir"
  mkdir -p "$dir"
  chmod 700 "$dir"
  ssh-keygen -q -t ed25519 -N "" -C "skynode-banc" -f "$key"
}

# Le démarrage se passe d'un point d'entrée compilé dans l'image : le conteneur reçoit la
# clé publique par l'environnement et l'installe lui-même. Un `docker cp` après démarrage
# laisserait une fenêtre où `sshd` écoute sans autoriser personne.
start_command() {
  mode="$1"
  # Guillemets simples : `$SKYNODE_BANC_PUBKEY` doit atteindre le shell du conteneur, pas
  # être remplacé ici.
  boot='set -e
mkdir -p /root/.ssh && chmod 700 /root/.ssh
printf "%s\n" "$SKYNODE_BANC_PUBKEY" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
'
  if [ "$mode" = "docker" ]; then
    boot="$boot"'dockerd >/var/log/dockerd.log 2>&1 &
'
  fi
  printf '%s' "$boot"'exec /usr/sbin/sshd -D -e'
}

host_port() {
  # `docker port` rend `0.0.0.0:32768` ou `[::]:32768` selon la pile : on ne garde que ce
  # qui suit le dernier `:`.
  docker port "$1" 22 2>/dev/null | head -n1 | sed 's/.*://'
}

ssh_to() {
  key="$1"
  port="$2"
  shift 2
  # shellcheck disable=SC2086  # SSH_OPTS est une liste d'options, pas un seul argument.
  ssh $SSH_OPTS -i "$key" -p "$port" "root@$BIND_ADDR" "$@"
}

wait_for_ssh() {
  key="$1"
  port="$2"
  i=0
  while [ "$i" -lt 60 ]; do
    if ssh_to "$key" "$port" true >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  die "le banc n'a pas ouvert son port SSH en 60 s."
}

wait_for_dockerd() {
  key="$1"
  port="$2"
  i=0
  while [ "$i" -lt 90 ]; do
    if ssh_to "$key" "$port" docker info >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  die "dockerd n'a pas démarré dans le conteneur en 90 s."
}

cmd_up() {
  mode="plain"
  # `if`, jamais `[ … ] && …` : sous `set -eu`, un test faux en fin de liste rend un code non
  # nul et ferait sortir le script au lieu de rester en mode `plain`.
  if [ "${1:-}" = "--with-docker" ]; then mode="docker"; fi

  require_docker
  name=$(mode_name "$mode")
  image=$(mode_image "$mode")
  key=$(mode_key "$mode")

  build_image "$mode"

  # Un banc déjà monté est démonté, pas complété : le jalon éprouve des scripts idempotents,
  # et les éprouver sur un serveur portant les traces du passage précédent ne prouverait pas
  # l'idempotence mais la masquerait.
  docker rm -f "$name" >/dev/null 2>&1 || true

  make_key "$key"

  log "→ montage de $name"
  if [ "$mode" = "docker" ]; then
    # `--privileged` : Docker-dans-Docker en a besoin (cgroups, montages, réseau). C'est
    # acceptable ici et nulle part ailleurs — ce conteneur est jetable et n'écoute que sur
    # la boucle locale.
    docker run -d --name "$name" --privileged \
      -v "$VOLUME_DOCKER:/var/lib/docker" \
      -e SKYNODE_BANC_PUBKEY="$(cat "$key.pub")" \
      -p "$BIND_ADDR::22" "$image" \
      sh -c "$(start_command "$mode")" >/dev/null
  else
    docker run -d --name "$name" \
      -e SKYNODE_BANC_PUBKEY="$(cat "$key.pub")" \
      -p "$BIND_ADDR::22" "$image" \
      sh -c "$(start_command "$mode")" >/dev/null
  fi

  port=$(host_port "$name")
  [ -n "$port" ] || die "le conteneur n'a pas publié de port SSH."

  wait_for_ssh "$key" "$port"
  if [ "$mode" = "docker" ]; then wait_for_dockerd "$key" "$port"; fi

  emit banc.mode "$mode"
  emit banc.conteneur "$name"
  emit banc.hote "$BIND_ADDR"
  emit banc.port "$port"
  emit banc.utilisateur root
  emit banc.cle "$key"
  emit banc.ssh "ssh $SSH_OPTS -i $key -p $port root@$BIND_ADDR"
  emit banc.end 1
}

cmd_ssh() {
  mode="plain"
  if [ "${1:-}" = "--with-docker" ]; then mode="docker"; shift; fi

  name=$(mode_name "$mode")
  key=$(mode_key "$mode")
  port=$(host_port "$name")
  [ -n "$port" ] || die "aucun banc « $name » ne tourne : lancer « banc.sh up » d'abord."
  [ -f "$key" ] || die "la clé du banc est introuvable ($key) : relancer « banc.sh up »."

  ssh_to "$key" "$port" "$@"
}

cmd_down() {
  require_docker
  # Les deux modes, la clé et le volume : un `down` partiel laisse justement ce qu'on
  # voulait ne pas laisser traîner. Les deux images construites restent, elles : elles ne
  # portent rien du passage — ni clé, ni état — et les supprimer imposerait une réinstallation
  # de paquets d'une minute à chaque montage, ce qui découragerait justement de démonter.
  docker rm -f "$NAME_PLAIN" "$NAME_DOCKER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME_DOCKER" >/dev/null 2>&1 || true
  rm -rf "$BANC_DIR"
  emit banc.demonte 1
  emit banc.end 1
}

cmd_status() {
  require_docker
  for name in "$NAME_PLAIN" "$NAME_DOCKER"; do
    port=$(host_port "$name")
    if [ -n "$port" ]; then emit "$name" "en marche, port $port"; else emit "$name" "absent"; fi
  done
  emit banc.end 1
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  ssh) shift; cmd_ssh "$@" ;;
  down) shift; cmd_down ;;
  status) shift; cmd_status ;;
  *) die "usage : banc.sh up [--with-docker] | ssh [--with-docker] [commande…] | down | status" ;;
esac
