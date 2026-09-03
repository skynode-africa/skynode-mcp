import { computeFingerprint } from "./fingerprint.js"
import type { Plan, PlanStep } from "./plan-types.js"
import {
  ALLOWED_NETWORK,
  CADDY_CONTAINER,
  DOMAIN_PATTERN,
  pathEscapes,
} from "./plan-rules.js"
import type { ServerFacts } from "./probe.js"
import { classify, type Classification } from "./regime.js"
import { isReversible } from "./step.js"

/**
 * Le périmètre de sécurité du produit (spec §6.1) : « Cette liste est le périmètre de
 * sécurité. Tout ce qui la traverse s'exécute. » Au jalon suivant, un plan qui passe ici
 * s'exécute en root sur la machine d'un client.
 *
 * Rien ici ne suppose que le plan vient de `composePlan` : la spec §5.1 autorise
 * explicitement un agent à modifier les étapes et à resoumettre le plan sous le même
 * identifiant. Chaque contrôle est écrit pour un plan qu'on suppose hostile, jamais pour
 * celui, bien élevé, que composerait ce jalon — jusqu'à la forme même des étapes : rien
 * ne garantit ici qu'elles ont traversé `parsePlan` avant d'atteindre cette fonction,
 * seulement que leur type TypeScript le prétend.
 */

export interface Violation {
  /**
   * La règle enfreinte, telle que la spec §6.1 les numérote. La règle 1 — le schéma —
   * n'y figure pas : `parsePlan` l'a déjà tranchée dans le chemin normal. Mais rien ne
   * force un appelant à passer par elle avant d'atteindre `validatePlan` — c'est
   * pourquoi un type d'étape hors du vocabulaire fermé, ou une étape mal formée, se
   * refusent quand même ici, sous la règle `dependances` ou `bornes` selon le cas. Ceci
   * vaut pour le `type` de chaque étape ; un sous-champ discriminant imbriqué, comme
   * `build.image.source.type`, n'est pas revérifié de la même façon — seule sa forme
   * (un `path` en chaîne) l'est ici, pas son appartenance au vocabulaire fermé.
   */
  regle: "empreinte" | "dependances" | "contradiction" | "regime" | "bornes"
  /** Ce qui ne va pas, en français, adressé à un agent qui doit corriger. */
  message: string
  /** L'index de l'étape fautive, quand une seule est en cause. */
  etape?: number
}

export type Validation = { ok: true } | { ok: false; violations: Violation[] }

/** Nos images seulement : ni registre tiers, ni chemin arbitraire. */
const TAG_PATTERN = /^skynode\/[a-z][a-z0-9-]{0,31}$/

/** Même plage que `HostPrepare.swap_mo` (`plan-types.ts`), revérifiée ici pour un plan
 * qui n'aurait pas traversé `parsePlan` : `fallocate -l 999999M` remplit un disque de VPS. */
const SWAP_MO_MIN = 0
const SWAP_MO_MAX = 8192

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

/** Le `type` d'une valeur quelconque tirée de `etapes`, sans supposer sa forme. */
function stepTypeOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null
  const type = (raw as { type?: unknown }).type
  return typeof type === "string" ? type : null
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

  /*
    La classification reçue est un argument comme un autre, pas une vérité qu'on
    suppose dérivée des faits qui l'accompagnent : rien n'empêche un appelant futur
    (jalon 3b, tâche 7, pas encore écrite) de rompre cette discipline et de présenter
    une machine occupée ou sans accès comme vierge et exécutable. `classify()`
    (`regime.ts`) est la seule source de vérité sur ce que ces faits impliquent ; on la
    rappelle ici plutôt que de faire confiance à l'appariement fourni.
  */
  const classificationReelle = classify(facts)
  if (
    classificationReelle.regime !== classification.regime ||
    classificationReelle.executable !== classification.executable
  ) {
    violations.push({
      regle: "regime",
      message:
        `La classification fournie ("${classification.regime}", executable: ` +
        `${classification.executable}) ne découle pas des faits constatés, qui donnent le ` +
        `régime "${classificationReelle.regime}" (executable: ${classificationReelle.executable}) : ` +
        "cet appariement ne peut pas venir d'un constat cohérent de la machine.",
    })
  }

  // Règles 1 (forme), 3, 4 et 6 — dépendances, contradictions et bornes : un seul passage
  // sur les étapes. Le graphe de dépendances est tenu ici, pas déduit de l'ordre proposé.
  const rawEtapes: unknown = plan.etapes

  if (!Array.isArray(rawEtapes)) {
    violations.push({
      regle: "dependances",
      message:
        "« etapes » n'est pas une liste exploitable : un plan sans étapes bien formées " +
        "n'a rien à appliquer.",
    })
    return { ok: false, violations }
  }

  if (rawEtapes.length === 0) {
    violations.push({
      regle: "dependances",
      message: "le plan ne contient aucune étape : il n'y a rien à appliquer.",
    })
  }

  // Chaque type n'apparaît qu'une fois : au jalon suivant, ce sont des commandes root
  // rejouées sur la machine d'un client — un `host.install_docker` répété relance
  // l'installation, un second `app.run` écraserait le conteneur du premier.
  const indicesParType = new Map<string, number[]>()
  rawEtapes.forEach((raw, index) => {
    const type = stepTypeOf(raw)
    if (type === null) return
    const indices = indicesParType.get(type) ?? []
    indices.push(index)
    indicesParType.set(type, indices)
  })
  for (const [type, indices] of indicesParType) {
    if (indices.length > 1) {
      violations.push({
        regle: "dependances",
        message:
          `le type d'étape "${type}" apparaît ${indices.length} fois (index ${indices.join(", ")}) ` +
          " : chaque type ne peut figurer qu'une seule fois dans un plan.",
      })
    }
  }

  // Docker « présent mais inutilisable » (démon arrêté, utilisateur hors du groupe) n'est
  // pas Docker disponible : `classify()` distingue déjà les deux (`regime.ts`, blockers).
  let dockerAvailable = facts.docker.present && facts.docker.usable
  let caddyAvailable = caddyAlreadyPresent(facts)
  let buildImageSeen = false
  let appRunSeen = false
  /** Le port que le Dockerfile engendré impose, quand le plan en engendre un. */
  let portDockerfile: number | null = null
  const lastIndex = rawEtapes.length - 1

  rawEtapes.forEach((raw, index) => {
    const type = stepTypeOf(raw)

    // Ni un objet, ni un `type` en chaîne : ce n'est l'étape d'aucun vocabulaire, connu
    // ou non. `parsePlan` l'aurait déjà rejeté ; rien ne garantit qu'il est passé par là.
    if (type === null) {
      violations.push({
        regle: "dependances",
        etape: index,
        message: `étape ${index} : ne correspond à aucune étape reconnaissable — ni objet, ni type déclaré.`,
      })
      return
    }

    const etape = raw as PlanStep

    switch (etape.type) {
      case "host.prepare": {
        const swap: unknown = etape.swap_mo
        if (
          typeof swap !== "number" ||
          !Number.isInteger(swap) ||
          swap < SWAP_MO_MIN ||
          swap > SWAP_MO_MAX
        ) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (host.prepare) : le fichier d'échange demandé (${String(swap)} Mio) ` +
              `est hors de la plage ${SWAP_MO_MIN}-${SWAP_MO_MAX}.`,
          })
        }
        break
      }

      case "host.install_docker":
        if (dockerAvailable) {
          violations.push({
            regle: "contradiction",
            etape: index,
            message:
              `étape ${index} (host.install_docker) contredit l'état constaté : Docker est déjà ` +
              "installé et utilisable sur cette machine — cette étape est inutile et modifierait " +
              "une installation existante.",
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
              "host.install_docker plus haut dans le plan, ni Docker déjà présent et utilisable sur la machine.",
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
        // Retenu pour être confronté au port d'`app.run` plus bas : le gabarit fixe
        // `ENV PORT` et `EXPOSE` dessus, et c'est l'étiquette d'`app.run` qui dit au proxy
        // où frapper. Le `typeof` n'est pas superflu — rien ne garantit ici qu'une étape a
        // traversé `parsePlan`, seulement que son type TypeScript le prétend.
        if (typeof etape.port === "number") portDockerfile = etape.port
        break

      case "build.image": {
        if (!dockerAvailable) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (build.image) exige Docker disponible avant elle : ni ` +
              "host.install_docker plus haut dans le plan, ni Docker déjà présent et utilisable sur la machine.",
          })
        }

        const source: unknown = etape.source
        const path =
          source !== null && typeof source === "object" && typeof (source as { path?: unknown }).path === "string"
            ? (source as { path: string }).path
            : null

        if (path === null) {
          violations.push({
            regle: "bornes",
            etape: index,
            message: `étape ${index} (build.image) : la source de construction est absente ou mal formée.`,
          })
        } else if (pathEscapes(path)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (build.image) : le chemin "${path}" échappe à la racine du projet — ` +
              'un chemin absolu ou un segment ".." n\'est jamais accepté.',
          })
        }

        const tag: unknown = etape.tag
        if (typeof tag !== "string") {
          violations.push({
            regle: "bornes",
            etape: index,
            message: `étape ${index} (build.image) : l'étiquette d'image est absente ou mal formée.`,
          })
        } else if (!TAG_PATTERN.test(tag)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (build.image) : l'étiquette "${tag}" est hors du périmètre autorisé — ` +
              'seules les images "skynode/…" en minuscules sont permises, aucun registre tiers.',
          })
        }

        buildImageSeen = true
        break
      }

      case "env.write": {
        if (appRunSeen) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (env.write) doit précéder app.run : écrire l'environnement après ` +
              "avoir démarré le conteneur n'aurait aucun effet sur celui-ci.",
          })
        }

        const depuis: unknown = etape.depuis
        if (typeof depuis !== "string") {
          violations.push({
            regle: "bornes",
            etape: index,
            message: `étape ${index} (env.write) : le fichier source est absent ou mal formé.`,
          })
        } else if (pathEscapes(depuis)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (env.write) : le fichier "${depuis}" échappe à la racine du projet — ` +
              'un chemin absolu ou un segment ".." n\'est jamais accepté.',
          })
        }
        break
      }

      case "app.run": {
        // Le Dockerfile engendré fixe `ENV PORT` et `EXPOSE` sur **son** port ; `app.run`
        // étiquette le conteneur avec le sien, et c'est cette étiquette que
        // `proxy.caddy.site` relit pour router. Désaccordés, Caddy frappe une porte que
        // l'application n'ouvre pas : un 502 que ni le plan ni le rapport n'expliquent.
        // Le composeur tire les deux de la même valeur, mais un plan peut être modifié et
        // resoumis entre la composition et l'exécution (spec §5.1).
        if (portDockerfile !== null && etape.port_interne !== portDockerfile) {
          violations.push({
            regle: "contradiction",
            etape: index,
            message:
              `étape ${index} (app.run) : le conteneur est étiqueté sur le port ${String(etape.port_interne)} ` +
              `alors que le Dockerfile engendré fait écouter l'application sur ${String(portDockerfile)}. ` +
              "Le proxy routerait vers un port fermé.",
          })
        }

        if (!buildImageSeen) {
          violations.push({
            regle: "dependances",
            etape: index,
            message:
              `étape ${index} (app.run) exige que build.image apparaisse plus haut dans le plan : ` +
              "il n'y a pas d'image construite à démarrer.",
          })
        }

        const port: unknown = etape.port_interne
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
          violations.push({
            regle: "bornes",
            etape: index,
            message: `étape ${index} (app.run) : le port (${String(port)}) est hors de la plage 1-65535.`,
          })
        }

        const reseau: unknown = etape.reseau
        if (typeof reseau !== "string") {
          violations.push({
            regle: "bornes",
            etape: index,
            message: `étape ${index} (app.run) : le réseau est absent ou mal formé.`,
          })
        } else if (reseau === "host") {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (app.run) : le réseau "host" donnerait au conteneur la pile ` +
              "réseau de la machine — l'accès à tout ce qui écoute sur la boucle locale, la " +
              'base de données d\'un autre client comprise. Seul le réseau "skynode" est autorisé.',
          })
        } else if (reseau !== ALLOWED_NETWORK) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (app.run) : le réseau "${reseau}" n'est pas autorisé — seul le ` +
              'réseau "skynode" peut être utilisé.',
          })
        }

        appRunSeen = true
        break
      }

      case "proxy.caddy.site": {
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

        const domaine: unknown = etape.domaine
        if (typeof domaine !== "string" || !DOMAIN_PATTERN.test(domaine)) {
          violations.push({
            regle: "bornes",
            etape: index,
            message:
              `étape ${index} (proxy.caddy.site) : "${String(domaine)}" n'est pas un nom de domaine ` +
              "valide — un nom d'hôte simple est attendu, sans schéma, sans chemin et sans port.",
          })
        }
        break
      }

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

      // Aucun des neuf types connus : le vocabulaire fermé du jalon (`plan-types.ts`)
      // n'admet que ceux-ci. `parsePlan` l'aurait refusé dans le chemin normal ; ici, un
      // type inconnu se refuse quand même, plutôt que de traverser en silence.
      default:
        violations.push({
          regle: "dependances",
          etape: index,
          message: `étape ${index} : type d'étape inconnu ("${type}") — hors du vocabulaire fermé.`,
        })
    }
  })

  // Le champ `reversible` est **déclaré** par le plan, et `formatPlan` ne s'y fie plus : il
  // déduit des étapes ce qui ne se défera pas. Mais le champ subsiste au schéma, et un plan
  // qui l'affirme contre ses propres étapes ment à quiconque le relit — un outil, un
  // journal, une version future de ce code. On refuse plutôt que de laisser cohabiter deux
  // vérités.
  const reversibleReel = plan.etapes.every((etape) => isReversible(etape))
  if (plan.reversible !== reversibleReel) {
    violations.push({
      regle: "contradiction",
      message: reversibleReel
        ? "Le plan se déclare irréversible alors que chacune de ses étapes sait se défaire."
        : "Le plan se déclare réversible alors qu'il porte des étapes qui ne se défont pas : " +
          "l'installation de paquets et la préparation de la machine sont définitives.",
    })
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}
