import type { ServerFacts } from "./probe.js"

/**
 * Classification d'un constat brut en une décision exploitable par un agent.
 *
 * `ServerFacts` dit ce qui a été observé ; `classify()` dit ce qu'il faut en conclure.
 * Un seul régime gagne — le premier qui répond, dans un ordre qui n'est pas celui de la
 * gravité mais celui des conséquences d'une erreur : se tromper sur un panneau écrase sa
 * configuration, se tromper sur un système non géré fait perdre du temps en pure perte.
 */

export type Regime = "skynode" | "panneau" | "inconnu" | "occupe" | "docker" | "vierge"

export interface Classification {
  regime: Regime
  /** Vrai pour skynode, docker et vierge. Les trois autres sont des refus. */
  executable: boolean
  /** Ce qui a décidé du classement. Toujours rendu à l'agent. */
  because: string
  /** Ce qui gênerait un déploiement, même en régime exécutable. */
  blockers: string[]
  /** Les voies de sortie quand le régime n'est pas exécutable. */
  guidance: string[]
}

/** Ce que le jalon 3 sait préparer. Contabo ne livre rien d'autre par défaut. */
const SUPPORTED = new Map<string, string[]>([
  ["ubuntu", ["22.04", "24.04"]],
  ["debian", ["12", "13"]],
])

/**
 * Une écoute sur ces adresses ne tient pas le port public : `probe.ts` normalise déjà
 * l'IPv6 sans crochets (`[::1]` → `::1`), quelle que soit la source (`ss` ou `netstat`).
 */
const LOOPBACK = new Set(["127.0.0.1", "::1"])

function isSupportedOs(host: ServerFacts["host"]): boolean {
  return (SUPPORTED.get(host.osId) ?? []).includes(host.osVersion)
}

/** `Listener` n'est pas exporté par `probe.ts` : on le retrouve depuis `ServerFacts`. */
type Listener = ServerFacts["listeners"][number]

/** Le port public tenu par un tiers, ou `undefined` si rien ne le tient hors boucle locale. */
function publicListener(listeners: Listener[]): Listener | undefined {
  return listeners.find((l) => (l.port === 80 || l.port === 443) && !LOOPBACK.has(l.address))
}

/**
 * Cumulables et indépendants du régime : un disque plein ou une mémoire insuffisante ne
 * rendent pas un déploiement impossible en soi, ils le feraient échouer en cours de
 * construction — c'est une alerte à côté de la décision, pas la décision elle-même.
 */
function computeBlockers(facts: ServerFacts): string[] {
  const blockers: string[] = []

  if (facts.resources.diskUsePercent >= 90) {
    blockers.push(
      `le disque est occupé à ${facts.resources.diskUsePercent} % ; une construction Docker échouera avant la fin`
    )
  }

  if (facts.resources.memoryMb < 1024 && facts.resources.swapMb === 0) {
    blockers.push(
      `${facts.resources.memoryMb} Mio de mémoire sans fichier d'échange ; une construction sera probablement interrompue par le noyau`
    )
  }

  if (facts.docker.present && !facts.docker.usable) {
    blockers.push(BLOCAGE_DOCKER_INJOIGNABLE)
  }

  return blockers
}

/**
 * Le seul blocage que `plan-compose.ts` doit reconnaître pour l'attribuer à une cause
 * précise. Exporté plutôt que recherché par sous-chaîne : `b.includes("démon Docker")`
 * cessait de correspondre à la première reformulation de cette phrase, et le composeur
 * retombait alors en silence sur un message générique — la divergence entre deux copies
 * d'une même règle est ce qui a coûté le plus cher au jalon précédent.
 */
export const BLOCAGE_DOCKER_INJOIGNABLE =
  "le démon Docker n'est pas joignable pour cet utilisateur ; il est arrêté, ou le compte n'est pas dans le groupe `docker`"

export function classify(facts: ServerFacts): Classification {
  const blockers = computeBlockers(facts)

  if (facts.skynode.present) {
    return {
      regime: "skynode",
      executable: true,
      because: "Un état SkyNode existe déjà sur cette machine (/etc/skynode/state.json) : elle est déjà gérée.",
      blockers,
      guidance: [],
    }
  }

  if (facts.panel !== null) {
    const panel = facts.panel.id

    return {
      regime: "panneau",
      executable: false,
      because:
        `Un panneau de gestion (${panel}) est installé : SkyNode ne modifiera pas sa configuration ` +
        "— ces outils régénèrent leurs fichiers, et une modification faite à côté disparaîtrait sans avertissement.",
      blockers,
      guidance: [
        `Pilotez ${panel} depuis son API si vous disposez d'un outil pour cela : créez une clé dans son interface, rubrique API ou Jetons.`,
        "Déployez à côté sans toucher au routage : un conteneur sur un port interne, ni 80 ni 443 pris, et donnez la règle de proxy à coller vous-même dans le panneau.",
        `Sinon, déployez à la main par ${panel}.`,
      ],
    }
  }

  if (!isSupportedOs(facts.host)) {
    const system = facts.host.osName || `${facts.host.osId} ${facts.host.osVersion}`.trim()

    return {
      regime: "inconnu",
      executable: false,
      because: `Système hors des versions gérées (${system}) : le jalon 3 ne sait pas préparer cette machine.`,
      blockers,
      guidance: [
        "Vérifiez la version exacte avec `cat /etc/os-release` : la détection peut se tromper sur un système dérivé.",
        "Provisionnez une machine sur un système géré : Ubuntu 22.04 ou 24.04, Debian 12 ou 13.",
        "Si ce système doit être supporté, remontez-le à SkyNode : le jalon 3 peut être étendu.",
      ],
    }
  }

  if (facts.access.elevate === "aucun") {
    return {
      regime: "inconnu",
      executable: false,
      because:
        "Le compte utilisé n'a pas d'élévation : ni `root`, ni `sudo` sans mot de passe. " +
        "SkyNode ne peut donc rien installer ici. Connectez-vous en `root`, ou donnez à ce " +
        "compte une règle `sudo` sans mot de passe, puis relancez le constat.",
      blockers,
      guidance: [
        "Fournissez un accès `root`, ou ajoutez l'utilisateur au fichier sudoers avec un droit NOPASSWD sur les commandes nécessaires.",
        "Si l'accès ne peut pas être élevé, ce serveur ne peut pas être préparé par SkyNode : traitez-le à la main.",
      ],
    }
  }

  const occupied = publicListener(facts.listeners)

  if (occupied) {
    return {
      regime: "occupe",
      executable: false,
      because: `Le port ${occupied.port} est déjà tenu par ${occupied.process ?? "un processus inconnu"} : SkyNode ne peut pas s'y installer sans y toucher.`,
      blockers,
      guidance: [
        "Déployez sur un port interne (ex. 8080) et ajoutez vous-même la règle de proxy sur le service déjà installé.",
        "Libérez le port si le service qui le tient n'est plus utilisé, puis relancez l'inspection.",
      ],
    }
  }

  if (facts.docker.present) {
    return {
      regime: "docker",
      executable: true,
      because: "Docker est installé sur cette machine : un déploiement en conteneur peut cohabiter avec ce qui tourne déjà.",
      blockers,
      guidance: [],
    }
  }

  return {
    regime: "vierge",
    executable: true,
    because: "Aucun panneau, aucun système non géré et aucun tiers ne tient les ports 80 ou 443 : la machine est prête pour un premier déploiement.",
    blockers,
    guidance: [],
  }
}
