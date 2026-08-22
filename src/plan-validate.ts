import { computeFingerprint } from "./fingerprint.js"
import type { Plan } from "./plan-types.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"

/**
 * Le périmètre de sécurité du produit (spec §6.1) : « Cette liste est le périmètre de
 * sécurité. Tout ce qui la traverse s'exécute. » Au jalon suivant, un plan qui passe ici
 * s'exécute en root sur la machine d'un client.
 *
 * Rien ici ne suppose que le plan vient de `composePlan` : la spec §5.1 autorise
 * explicitement un agent à modifier les étapes et à resoumettre le plan sous le même
 * identifiant. Chaque contrôle est écrit pour un plan qu'on suppose hostile, jamais pour
 * celui, bien élevé, que composerait ce jalon.
 */

export interface Violation {
  /**
   * La règle enfreinte, telle que la spec §6.1 les numérote. La règle 1 — le schéma —
   * n'y figure pas : `parsePlan` l'a déjà tranchée, et rien ne parvient ici sans être
   * passé par elle.
   */
  regle: "empreinte" | "dependances" | "contradiction" | "regime" | "bornes"
  /** Ce qui ne va pas, en français, adressé à un agent qui doit corriger. */
  message: string
  /** L'index de l'étape fautive, quand une seule est en cause. */
  etape?: number
}

export type Validation = { ok: true } | { ok: false; violations: Violation[] }

/** Le nôtre, et rien d'autre. `host` donnerait au conteneur la pile réseau de la machine. */
const ALLOWED_NETWORK = "skynode"

/** Un nom d'hôte, sans schéma, sans chemin, sans port. */
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

/** Nos images seulement : ni registre tiers, ni chemin arbitraire. */
const TAG_PATTERN = /^skynode\/[a-z][a-z0-9-]{0,31}$/

/** Un chemin relatif qui ne remonte jamais. */
const PATH_PATTERN = /^(\.|[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/

/**
 * Repris de `fingerprint.ts`, qui ne l'exporte pas : le nom que prend le conteneur Caddy
 * quand c'est SkyNode qui l'a posé.
 */
const CADDY_CONTAINER = "skynode-caddy"

/**
 * Repris de `regime.ts`, qui ne l'exporte pas : une écoute sur ces adresses ne tient pas
 * le port public.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1"])

function caddyAlreadyPresent(facts: ServerFacts): boolean {
  return facts.docker.containers.some((c) => c.name === CADDY_CONTAINER)
}

/** Le port public déjà tenu par un tiers, ou `undefined` si rien ne le tient hors boucle locale. */
function publicListener(facts: ServerFacts): ServerFacts["listeners"][number] | undefined {
  return facts.listeners.find((l) => (l.port === 80 || l.port === 443) && !LOOPBACK.has(l.address))
}

/**
 * Un chemin est refusé s'il est absolu, s'il contient un segment `..`, ou s'il ne
 * correspond pas à `PATH_PATTERN` — les trois contrôles, pas seulement le motif : un
 * motif seul se contourne par encodage.
 */
function pathEscapes(path: string): boolean {
  if (path.startsWith("/")) return true
  if (path.split("/").includes("..")) return true
  return !PATH_PATTERN.test(path)
}

/**
 * Vérifie un plan contre l'état réel de la machine, sans supposer qu'il vient du
 * composeur. Accumule les violations plutôt que de s'arrêter à la première : un agent
 * qui corrige un plan doit voir tout ce qui cloche, sinon il repart pour autant
 * d'allers-retours qu'il y a de fautes.
 */
export function validatePlan(plan: Plan, facts: ServerFacts, classification: Classification): Validation {
  const violations: Violation[] = []

  // Règle 2 — l'empreinte d'état : détecte une machine modifiée entre la proposition du
  // plan et sa validation. Cas courant sur un serveur qu'un humain administre aussi.
  if (plan.empreinte_etat !== computeFingerprint(facts, classification)) {
    violations.push({
      regle: "empreinte",
      message:
        "L'empreinte du plan ne correspond plus à l'état constaté de la machine : quelque " +
        "chose a changé depuis sa composition. Relancez inspect_server puis recomposez le plan.",
    })
  }

  // Règle 5 — le régime : un régime non exécutable ne se rattrape pas, et un plan dont le
  // régime déclaré diverge de celui constaté décrit une machine qui n'existe plus.
  if (!classification.executable) {
    violations.push({
      regle: "regime",
      message: `Le régime constaté ("${classification.regime}") n'est pas exécutable : ${classification.because}`,
    })
  }
  if (plan.regime !== classification.regime) {
    violations.push({
      regle: "regime",
      message:
        `Le plan déclare le régime "${plan.regime}" mais la machine constatée est en régime ` +
        `"${classification.regime}" : ce plan ne décrit plus l'état réel de la machine.`,
    })
  }

  // Règles 3, 4 et 6 — dépendances, contradictions et bornes : un seul passage sur les
  // étapes. Le graphe de dépendances est tenu ici, pas déduit de l'ordre proposé.
  let dockerAvailable = facts.docker.present
  let caddyAvailable = caddyAlreadyPresent(facts)
  let buildImageSeen = false
  let appRunSeen = false
  const lastIndex = plan.etapes.length - 1

  plan.etapes.forEach((etape, index) => {
    switch (etape.type) {
      case "host.prepare":
        break

      case "host.install_docker":
        if (facts.docker.present) {
          violations.push({
            regle: "contradiction",
            etape: index,
            message:
              `étape ${index} (host.install_docker) contredit l'état constaté : Docker est déjà ` +
              "installé sur cette machine — cette étape est inutile et modifierait une installation existante.",
          })
        }
        dockerAvailable = true
        break

      case "proxy.caddy.install": {
        if (!dockerAvailable) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (proxy.caddy.install) exige Docker disponible avant elle : ni ` +
              "host.install_docker plus haut dans le plan, ni Docker déjà présent sur la machine.",
          })
        }
        const held = publicListener(facts)
        if (held) {
          violations.push({
            regle: "contradiction",
            etape: index,
            message:
              `étape ${index} (proxy.caddy.install) contredit l'état constaté : le port ${held.port} ` +
              `est déjà tenu par ${held.process ?? "un processus inconnu"} — Caddy ne pourra pas s'y lier.`,
          })
        }
        caddyAvailable = true
        break
      }

      case "build.generate_dockerfile":
        break

      case "build.image":
        if (!dockerAvailable) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (build.image) exige Docker disponible avant elle : ni ` +
              "host.install_docker plus haut dans le plan, ni Docker déjà présent sur la machine.",
          })
        }
        if (pathEscapes(etape.source.path)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (build.image) : le chemin "${etape.source.path}" échappe à la racine ` +
              'du projet — un chemin absolu ou un segment ".." n\'est jamais accepté.',
          })
        }
        if (!TAG_PATTERN.test(etape.tag)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (build.image) : l'étiquette "${etape.tag}" est hors du périmètre ` +
              'autorisé — seules les images "skynode/…" en minuscules sont permises, aucun registre tiers.',
          })
        }
        buildImageSeen = true
        break

      case "env.write":
        if (appRunSeen) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (env.write) doit précéder app.run : écrire l'environnement après ` +
              "avoir démarré le conteneur n'aurait aucun effet sur celui-ci.",
          })
        }
        if (pathEscapes(etape.depuis)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (env.write) : le fichier "${etape.depuis}" échappe à la racine du ` +
              'projet — un chemin absolu ou un segment ".." n\'est jamais accepté.',
          })
        }
        break

      case "app.run":
        if (!buildImageSeen) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (app.run) exige que build.image apparaisse plus haut dans le plan : ` +
              "il n'y a pas d'image construite à démarrer.",
          })
        }
        if (!Number.isInteger(etape.port_interne) || etape.port_interne < 1 || etape.port_interne > 65535) {
          violations.push({
            regle: "bornes",
            etape: index,
            message: `étape ${index} (app.run) : le port ${etape.port_interne} est hors de la plage 1-65535.`,
          })
        }
        if (etape.reseau !== ALLOWED_NETWORK) {
          if (etape.reseau === "host") {
            violations.push({
              regle: "bornes",
              etape: index,
              message:
                `étape ${index} (app.run) : le réseau "host" donnerait au conteneur la pile ` +
                "réseau de la machine — l'accès à tout ce qui écoute sur la boucle locale, la " +
                'base de données d\'un autre client comprise. Seul le réseau "skynode" est autorisé.',
            })
          } else {
            violations.push({
              regle: "bornes",
              etape: index,
              message:
                `étape ${index} (app.run) : le réseau "${etape.reseau}" n'est pas autorisé — seul ` +
                'le réseau "skynode" peut être utilisé.',
            })
          }
        }
        appRunSeen = true
        break

      case "proxy.caddy.site":
        if (!caddyAvailable) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (proxy.caddy.site) exige que Caddy soit disponible : ni ` +
              "proxy.caddy.install plus haut dans le plan, ni Caddy déjà présent sur la machine.",
          })
        }
        if (!appRunSeen) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (proxy.caddy.site) exige que app.run apparaisse plus haut dans le ` +
              "plan : il n'y a rien à publier.",
          })
        }
        if (!DOMAIN_PATTERN.test(etape.domaine)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (proxy.caddy.site) : "${etape.domaine}" n'est pas un nom de domaine ` +
              "valide — un nom d'hôte simple est attendu, sans schéma, sans chemin et sans port.",
          })
        }
        break

      case "state.record":
        if (index !== lastIndex) {
          violations.push({
            regle: "dependances",
            etape: index,
            message: `étape ${index} (state.record) doit être la dernière étape du plan.`,
          })
        }
        if (index === 0) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (state.record) doit être précédée d'au moins une autre étape : ` +
              "il n'y a rien à enregistrer.",
          })
        }
        break
    }
  })

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}
