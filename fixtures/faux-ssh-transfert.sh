#!/bin/sh
# Tient lieu de client ssh pour le transfert : joue en local le script que `transferProject`
# passe en argument (`/bin/sh -c …`), sur la même entrée standard.
#
# Le but est d'éprouver `tar` et le script de réception pour de vrai — exclusions comprises —
# sans serveur. Une doublure qui se contenterait de rendre un code de sortie ne dirait rien
# de ce qui traverse effectivement le réseau, qui est justement l'invariant à tenir.
script=""
precedent=""
for argument in "$@"; do
  if [ "$precedent" = "-c" ]; then script="$argument"; fi
  precedent="$argument"
done

if [ -z "$script" ]; then
  printf 'aucun script « -c » dans les arguments\n' >&2
  exit 2
fi

exec /bin/sh -c "$script"
