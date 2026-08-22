#!/bin/sh
# Tient lieu de client ssh : renvoie les arguments reçus puis l'entrée standard.
printf 'ARGS %s\n' "$*"
cat
