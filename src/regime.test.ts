import { describe, expect, it } from "vitest"

import { classify } from "./regime.js"
import type { ServerFacts } from "./probe.js"

/**
 * `Partial<ServerFacts>` ne suffit pas : ses champs imbriqués (`host`, `resources`…)
 * restent obligatoires en bloc. `Deep` les rend optionnels récursivement, sans toucher
 * aux tableaux (`listeners`, `binaries`…), qui se remplacent entiers ou pas du tout.
 */
type Deep<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K]
}

/**
 * Une Ubuntu 24.04 en root, saine et vierge. Chaque test n'en écarte qu'un aspect, ce qui
 * rend visible dans sa seule ligne d'appel ce qui décide du classement.
 */
function facts(partial: Deep<ServerFacts> = {}): ServerFacts {
  return {
    host: {
      user: "root",
      uid: 0,
      arch: "x86_64",
      kernel: "6.8.0",
      osId: "ubuntu",
      osVersion: "24.04",
      osName: "Ubuntu 24.04.1 LTS",
      ...partial.host,
    },
    resources: {
      cpu: 4,
      memoryMb: 7943,
      swapMb: 0,
      diskUsePercent: 8,
      ...partial.resources,
    },
    access: { elevate: "root", ...partial.access },
    docker: {
      present: false,
      usable: false,
      version: "",
      compose: false,
      containers: [],
      networks: [],
      ...partial.docker,
    },
    podmanPresent: partial.podmanPresent ?? false,
    binaries: partial.binaries ?? [],
    listeners: partial.listeners ?? [],
    services: partial.services ?? [],
    panel: partial.panel ?? null,
    skynode: { present: false, raw: null, ...partial.skynode },
  }
}

describe("classify", () => {
  it("classe une machine neuve en vierge", () => {
    const c = classify(facts())
    expect(c.regime).toBe("vierge")
    expect(c.executable).toBe(true)
  })

  it("classe en docker une machine où Docker est installé", () => {
    const c = classify(facts({ docker: { present: true, usable: true } }))
    expect(c.regime).toBe("docker")
    expect(c.executable).toBe(true)
    expect(c.blockers).toEqual([])
  })

  /**
   * Présent n'est pas utilisable. Réinstaller Docker sur une machine qui l'a déjà
   * casserait les conteneurs en cours ; le bon geste est d'ajouter l'utilisateur au
   * groupe, et c'est un blocage, pas un changement de régime.
   */
  it("classe en docker mais bloque quand le démon n'est pas joignable", () => {
    const c = classify(facts({ docker: { present: true, usable: false } }))
    expect(c.regime).toBe("docker")
    expect(c.blockers.join(" ")).toMatch(/démon Docker/)
  })

  it("classe en skynode dès que l'état est présent", () => {
    const c = classify(
      facts({ skynode: { present: true, raw: "{}" }, docker: { present: true, usable: true } })
    )
    expect(c.regime).toBe("skynode")
  })

  /**
   * Coolify, Dokploy et CapRover tournent *dans* Docker. Sans cette priorité, un serveur
   * Coolify serait classé « docker » et on déploierait à côté d'un orchestrateur qui
   * croit posséder la machine — le conteneur serait ramassé au prochain élagage.
   */
  it("fait primer le panneau sur Docker", () => {
    const c = classify(
      facts({
        panel: { id: "coolify", path: "/data/coolify" },
        docker: { present: true, usable: true },
      })
    )
    expect(c.regime).toBe("panneau")
    expect(c.executable).toBe(false)
    expect(c.because).toMatch(/coolify/i)
  })

  it("rend les trois voies de sortie pour un panneau", () => {
    const c = classify(facts({ panel: { id: "aapanel", path: "/www/server/panel" } }))
    expect(c.guidance).toHaveLength(3)
    expect(c.guidance.join(" ")).toMatch(/API/)
    expect(c.guidance.join(" ")).toMatch(/port interne/)
    expect(c.guidance.join(" ")).toMatch(/manuel|à la main/)
    // On ne touche à rien : la promesse doit être écrite, pas seulement tenue.
    expect(c.because).toMatch(/ne modifiera/)
  })

  it("classe en inconnu un système hors des versions gérées, en les nommant", () => {
    const c = classify(facts({ host: { osId: "centos", osVersion: "7" } }))
    expect(c.regime).toBe("inconnu")
    expect(c.guidance.join(" ")).toMatch(/Ubuntu 22\.04.*24\.04.*Debian 12.*13/s)
  })

  it("classe en inconnu quand aucune élévation n'est possible", () => {
    const c = classify(facts({ access: { elevate: "aucun" } }))
    expect(c.regime).toBe("inconnu")
    expect(c.because).toMatch(/sudo|root/)
  })

  /**
   * Un système non géré l'emporte sur un port occupé : libérer le port ne rendrait pas
   * la machine préparable pour autant.
   */
  it("fait primer inconnu sur occupé", () => {
    const c = classify(
      facts({
        host: { osId: "centos", osVersion: "7" },
        listeners: [{ address: "0.0.0.0", port: 80, process: "nginx" }],
      })
    )
    expect(c.regime).toBe("inconnu")
  })

  it("classe en occupé quand un tiers tient le port 80", () => {
    const c = classify(facts({ listeners: [{ address: "0.0.0.0", port: 80, process: "nginx" }] }))
    expect(c.regime).toBe("occupe")
    expect(c.because).toMatch(/nginx/)
    expect(c.guidance.join(" ")).toMatch(/port interne/)
  })

  /**
   * Un service sur la boucle locale ne tient pas le port public : il est déjà derrière
   * un proxy, ou n'écoute que pour la machine. Le classer « occupé » refuserait des
   * serveurs parfaitement déployables.
   */
  it("ignore ce qui n'écoute que sur la boucle locale", () => {
    const c = classify(facts({ listeners: [{ address: "127.0.0.1", port: 80, process: "x" }] }))
    expect(c.regime).toBe("vierge")
  })

  it("signale un disque presque plein sans changer le régime", () => {
    const c = classify(facts({ resources: { diskUsePercent: 94 } }))
    expect(c.regime).toBe("vierge")
    expect(c.blockers.join(" ")).toMatch(/94 %/)
    expect(c.blockers.join(" ")).toMatch(/construction/)
  })

  it("signale une mémoire insuffisante sans swap", () => {
    const c = classify(facts({ resources: { memoryMb: 900, swapMb: 0 } }))
    expect(c.blockers.join(" ")).toMatch(/mémoire/)
  })

  it("ne signale rien quand un swap compense la mémoire", () => {
    const c = classify(facts({ resources: { memoryMb: 900, swapMb: 2048 } }))
    expect(c.blockers).toEqual([])
  })

  /**
   * Un refus sans marche à suivre laisse le développeur devant un mur. C'est la règle
   * de la spec §12 — « le refus est une fonctionnalité à part entière » — et elle se
   * vérifie sur les trois régimes non exécutables à la fois.
   */
  it("n'a pas de régime refusé sans marche à suivre", () => {
    const refus = [
      classify(facts({ panel: { id: "plesk", path: "/opt/psa" } })),
      classify(facts({ host: { osId: "centos", osVersion: "7" } })),
      classify(facts({ listeners: [{ address: "0.0.0.0", port: 443, process: "apache2" }] })),
    ]

    expect(refus.map((c) => c.regime)).toEqual(["panneau", "inconnu", "occupe"])

    for (const c of refus) {
      expect(c.executable).toBe(false)
      expect(c.guidance.length).toBeGreaterThan(0)
      expect(c.because.length).toBeGreaterThan(0)
    }
  })
})
