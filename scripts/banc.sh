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
#   scripts/banc.sh check [--with-docker] < script    soumet un script au `dash` du banc
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
#
# Le segment `skynode-banc` est ajouté **y compris à la surcharge**, et pas seulement au
# défaut : `down` fait un `rm -rf` sur ce chemin. Sans ce suffixe, un
# `SKYNODE_BANC_DIR=$HOME/travail` exporté dans un profil ferait effacer `~/travail` en
# entier au premier `down`, en annonçant `banc.demonte 1` et en sortant 0. On ne supprime
# récursivement qu'un chemin dont ce script a lui-même choisi le dernier segment.
BANC_DIR="${SKYNODE_BANC_DIR:-${TMPDIR:-/tmp}}/skynode-banc"

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
# Aucune directive \`sshd\` n'est écrite ici, et c'est délibéré : le banc doit partir dans
# l'état d'un VPS nu. Le durcissement de la tâche 4 se vérifie par \`sshd -T\` ; un banc
# livré déjà durci lui ferait lire ses propres valeurs et son filet se validerait contre sa
# propre prémisse — sur la seule opération du produit dont l'échec est irréparable à
# distance. Les deux directives qui figuraient ici ne protégeaient d'ailleurs rien :
# \`prohibit-password\` est déjà le défaut compilé, et le compte root est verrouillé
# (\`getent shadow root\` rend \`*\`), donc aucun mot de passe ne l'ouvre.
#
# Si un jour le banc doit vraiment poser une directive, elle ira dans un fichier préfixé
# **99-**, jamais 00- : \`sshd\` retient la première valeur rencontrée et la tâche 4 écrit
# dans 50-skynode.conf, qu'un fichier trié avant rendrait inopérant.
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

# Un drapeau inconnu arrête tout. Retomber en mode `plain` sur un `--with-dokcer` mal
# tapé ferait éprouver les scripts du régime `docker` sur un banc qui n'en a pas, et le
# résultat se lirait comme un défaut du script au lieu d'une faute de frappe.
lire_mode() {
  case "${1:-}" in
    --with-docker ) printf 'docker\n' ;;
    # Tout ce qui commence par un tiret se veut un drapeau : le refuser, plutôt que de le
    # traiter en commande à exécuter sur le banc.
    -* ) die "drapeau inconnu : « $1 ». Seul « --with-docker » est reconnu." ;;
    # Le reste — rien, ou la commande que `ssh` doit jouer — laisse le mode par défaut.
    * ) printf 'plain\n' ;;
  esac
}

# Pour les sous-verbes qui n'acceptent aucun argument libre. Sans ce contrôle, un
# `banc.sh up docker` monterait silencieusement le banc simple.
refuse_arguments_libres() {
  verbe="$1"
  shift
  if [ "${1:-}" = "--with-docker" ]; then shift; fi
  [ $# -eq 0 ] || die "« $verbe » n'attend pas d'argument : « $1 » est de trop."
}

# Guillemets simples, avec `'` rendu par `'\''` — la seule forme sûre en `sh`. Sert aux
# lignes destinées à être copiées dans un terminal, pas à l'exécution.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

cmd_up() {
  # `lire_mode` d'abord : sur un « --with-dokcer » mal tapé, il nomme le drapeau plutôt que
  # de le signaler comme un argument de trop.
  mode=$(lire_mode "$@")
  refuse_arguments_libres up "$@"

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
  # Le chemin de la clé est cité : `TMPDIR` peut porter une espace ou une apostrophe, et
  # cette ligne est faite pour être copiée telle quelle dans un terminal.
  emit banc.ssh "ssh $SSH_OPTS -i $(shell_quote "$key") -p $port root@$BIND_ADDR"
  emit banc.end 1
}

cmd_ssh() {
  # Le démon d'abord : sans lui, `host_port` rend vide et on annoncerait « aucun banc ne
  # tourne », qui envoie chercher un banc démonté au lieu d'un Docker arrêté.
  require_docker

  mode=$(lire_mode "$@")
  if [ "${1:-}" = "--with-docker" ]; then shift; fi

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
  # Seul le `BANC_DIR` courant est effacé, faute de savoir où un autre `SKYNODE_BANC_DIR` a
  # pu poser ses clés. `down` est donc global sur les conteneurs et local sur les clés : le
  # dire, plutôt que de laisser une clé privée sur disque sous un « banc.demonte 1 » qui
  # paraît complet.
  rm -rf "$BANC_DIR"
  emit banc.demonte 1
  emit banc.cles_effacees "$BANC_DIR"
  emit banc.end 1
}

# Le contrôle « pas de bashisme » de `src/step.ts` ne connaît que les formes qu'on lui a
# apprises. `dash` est ce que la machine du client exécutera vraiment : c'est lui qui fait
# autorité. Les deux sont complémentaires et aucun ne remplace l'autre — mesuré sur un
# corpus de dix-huit bashismes, `dash -n` n'en refuse que six ; les douze autres sont
# syntaxiquement valides et changent seulement de sens.
cmd_check() {
  require_docker

  # `lire_mode` d'abord : sur un « --with-dokcer » mal tapé, il nomme le drapeau plutôt que
  # de le signaler comme un argument de trop.
  mode=$(lire_mode "$@")
  refuse_arguments_libres check "$@"
  if [ "${1:-}" = "--with-docker" ]; then shift; fi

  name=$(mode_name "$mode")
  key=$(mode_key "$mode")
  port=$(host_port "$name")
  [ -n "$port" ] || die "aucun banc « $name » ne tourne : lancer « banc.sh up » d'abord."

  # Le script arrive sur l'entrée standard et est écrit dans le conteneur sans passer par un
  # argument : un script porte des guillemets, des dollars et des sauts de ligne.
  if ssh_to "$key" "$port" 'cat > /tmp/verif.sh && dash -n /tmp/verif.sh'; then
    emit check.syntaxe ok
  else
    emit check.syntaxe refusee
    emit banc.end 1
    exit 1
  fi
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
  check) shift; cmd_check "$@" ;;
  *) die "usage : banc.sh up [--with-docker] | ssh [--with-docker] [commande…] | check [--with-docker] < script | down | status" ;;
esac
