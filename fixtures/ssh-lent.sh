#!/bin/sh
# Consigne son propre PID avant de s'y remplacer par `exec` : le test qui tue ce
# processus après le délai peut ainsi vérifier qu'il est bien mort, pas seulement
# détaché d'un interprète parent qui, lui, laisserait `sleep` orphelin en vie.
if [ -n "$SSH_LENT_PIDFILE" ]; then
  echo "$$" > "$SSH_LENT_PIDFILE"
fi
exec sleep 30
