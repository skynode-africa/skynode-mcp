import { createHash } from "node:crypto"

import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"

/**
 * La version des recettes. L'incrémenter invalide délibérément tous les plans en
 * circulation : un plan composé pour la version précédente pourrait poser une
 * configuration que la nouvelle ne sait plus reprendre.
 */
const RECIPE_VERSION = 1

/** Ce que Caddy s'appelle quand c'est nous qui l'avons posé. */
const CADDY_CONTAINER = "skynode-caddy"

/** Seuls ces binaires changent ce qu'un plan doit faire ; `certbot`, `git`, `tar` non. */
const TRACKED_BINARIES = ["apache2", "caddy", "httpd", "nginx"]

/** Seuls ces ports décident du régime « occupé » et de ce qu'un plan peut y poser. */
const TRACKED_PORTS = new Set([80, 443])

/**
 * L'empreinte n'ancre que les faits structurels — ceux qui changent ce qu'un plan doit
 * faire. Tout le reste (mémoire libre, disque, noyau, services, réseaux Docker,
 * conteneurs applicatifs) varie en permanence sans rien changer à la marche à suivre ;
 * l'y inclure ferait échouer `apply_plan` sur une machine saine, jusqu'à ce que la
 * protection soit désactivée — et une protection qu'on désactive ne protège plus rien.
 *
 * Le régime vient de `classification` plutôt que d'être recalculé ici : `classify()`
 * (jalon 2) est la seule source de cette logique, la dupliquer la ferait diverger.
 */
export function computeFingerprint(facts: ServerFacts, classification: Classification): string {
  const caddy = facts.docker.containers.some((c) => c.name === CADDY_CONTAINER)

  const binaires = facts.binaries
    .filter((b) => TRACKED_BINARIES.includes(b))
    .sort()

  // Triées par port puis adresse : deux sondes de la même machine peuvent rendre `ss`
  // dans un ordre différent, l'empreinte ne doit pas en dépendre.
  const ports = facts.listeners
    .filter((l) => TRACKED_PORTS.has(l.port))
    .map((l) => ({ port: l.port, address: l.address, process: l.process }))
    .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address))

  const structure = {
    regime: classification.regime,
    recette: RECIPE_VERSION,
    docker: {
      present: facts.docker.present,
      usable: facts.docker.usable,
      compose: facts.docker.compose,
    },
    caddy,
    binaires,
    ports,
    panneau: facts.panel?.id ?? null,
    skynode: facts.skynode.present,
  }

  const digest = createHash("sha256").update(JSON.stringify(structure)).digest("hex")

  return `sha256:${digest}`
}
