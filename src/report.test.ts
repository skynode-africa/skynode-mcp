import { describe, expect, it } from "vitest"

import { formatProjectReport, formatServerReport } from "./report.js"
import type { Instance } from "./api.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"
import type { ProjectFacts } from "./project-analyze.js"

/**
 * Recopié de `src/regime.test.ts` (tâche 4) : `Partial<ServerFacts>` ne suffit pas, ses
 * champs imbriqués restent obligatoires en bloc. `Deep` les rend optionnels
 * récursivement, sans toucher aux tableaux, qui se remplacent entiers ou pas du tout.
 */
type Deep<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K]
}

/** Recopié de `src/regime.test.ts` : une Ubuntu 24.04 en root, saine et vierge. */
function serverFacts(partial: Deep<ServerFacts> = {}): ServerFacts {
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

/** Recopié de `src/ssh.test.ts` (tâche 5). */
function instance(partial: Partial<Instance> = {}): Instance {
  return {
    id: "i-3f2a", hostname: "boutique", status: "RUNNING",
    ipv4: "192.0.2.10", ipv6: null, region: "EU", osImage: "ubuntu-24.04",
    planId: "vps-s", cycle: "MONTHLY", defaultUser: "root",
    nextRenewalAt: null, provisionedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  }
}

function classification(partial: Partial<Classification> = {}): Classification {
  return {
    regime: "vierge", executable: true,
    because: "aucun service web, Docker absent, Ubuntu 24.04 en root",
    blockers: [], guidance: [], ...partial,
  }
}

function projectFacts(partial: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    root: "/projet",
    declared: { dockerfiles: [], composeFiles: [], services: [], ...partial.declared },
    runtime: { family: "node", evidence: ["package.json"], version: "22",
               packageManager: "pnpm", ...partial.runtime },
    framework: partial.framework ?? null,
    output: { mode: "server", directory: null, ...partial.output },
    port: { value: 3000, source: "port par défaut de Next.js", ...partial.port },
    env: { keys: [], files: [], hasLocalSecrets: false, ...partial.env },
    data: { engines: [], migrations: null, ...partial.data },
    weight: { files: 120, bytes: 2_400_000, tronque: false, ...partial.weight },
    warnings: partial.warnings ?? [],
    monorepo: { detected: false, packages: [], ...partial.monorepo },
  }
}

describe("formatProjectReport", () => {
  it("annonce la conclusion en première ligne", () => {
    const rapport = formatProjectReport(projectFacts({ framework: "next" }))
    expect(rapport.split("\n")[0]).toMatch(/Next\.js/i)
  })

  /** La règle de la spec §5.3 : le dépôt qui se déclare l'emporte. L'agent doit le lire. */
  it("met un Dockerfile déclaré en évidence", () => {
    const rapport = formatProjectReport(projectFacts({ declared: { dockerfiles: ["Dockerfile"] } }))
    expect(rapport).toMatch(/Dockerfile.*fourni|fournit un Dockerfile/i)
  })

  it("dit qu'il n'y a pas de Dockerfile, et que c'est un cas géré", () => {
    const rapport = formatProjectReport(projectFacts({}))
    expect(rapport).toMatch(/aucun Dockerfile/i)
    expect(rapport).toMatch(/généré|généré au déploiement/i)
  })

  it("rend les clés d'environnement, jamais de valeur", () => {
    const rapport = formatProjectReport(
      projectFacts({ env: { keys: ["DATABASE_URL"], files: [".env.production"], hasLocalSecrets: true } })
    )
    expect(rapport).toContain("DATABASE_URL")
    expect(rapport).toMatch(/valeurs? ne (sont|sera)/i)
  })

  it("reprend les avertissements", () => {
    const rapport = formatProjectReport(projectFacts({ warnings: ["monorepo : préciser le paquet"] }))
    expect(rapport).toContain("monorepo : préciser le paquet")
  })

  it("dit quoi faire quand la famille est inconnue", () => {
    const rapport = formatProjectReport(projectFacts({ runtime: { family: "inconnu" } }))
    expect(rapport).toMatch(/Dockerfile/)
    expect(rapport).not.toMatch(/erreur|échec/i)
  })
})

describe("formatServerReport", () => {
  it("annonce le régime et l'issue en première ligne", () => {
    const rapport = formatServerReport(instance(), serverFacts(), classification({ regime: "vierge" }))
    expect(rapport.split("\n")[0]).toMatch(/vierge/i)
    expect(rapport.split("\n")[0]).toMatch(/déploiement est possible|prêt à être préparé/i)
  })

  /** Un refus doit être lisible comme un constat, jamais comme une panne. */
  it("place la marche à suivre avant tout détail pour un régime non exécutable", () => {
    const rapport = formatServerReport(
      instance(),
      serverFacts(),
      classification({
        regime: "panneau",
        executable: false,
        because: "aaPanel est installé ; SkyNode ne modifiera pas sa configuration.",
        guidance: ["voie 1", "voie 2", "voie 3"],
      })
    )

    expect(rapport.indexOf("voie 1")).toBeLessThan(rapport.indexOf("Ubuntu"))
    expect(rapport).not.toMatch(/erreur|échec|impossible de constater/i)
  })

  it("rend les blocages même en régime exécutable", () => {
    const rapport = formatServerReport(
      instance(), serverFacts(), classification({ blockers: ["le disque est occupé à 94 %"] })
    )
    expect(rapport).toContain("94 %")
  })

  it("liste les conteneurs mais pas les réseaux ni les services systemd", () => {
    const rapport = formatServerReport(
      instance(),
      serverFacts({
        docker: {
          present: true, usable: true, containers: [{ name: "caddy", image: "caddy:2", state: "running", ports: "" }],
          networks: ["bridge", "skynode"],
        },
        services: ["ssh.service", "cron.service"],
      }),
      classification({ regime: "docker" })
    )

    expect(rapport).toContain("caddy")
    expect(rapport).not.toContain("bridge")
    expect(rapport).not.toContain("cron.service")
  })

  it("nomme le service qui tient le port 80", () => {
    const rapport = formatServerReport(
      instance(),
      serverFacts({ listeners: [{ address: "0.0.0.0", port: 80, process: "nginx" }] }),
      classification({ regime: "occupe", executable: false, because: "nginx tient le port 80" })
    )
    expect(rapport).toContain("nginx")
  })

  /** Le rapport tient dans le contexte d'un agent : au-delà, il coûte plus qu'il ne sert. */
  it("reste sous 3 000 caractères sur une machine chargée", () => {
    const rapport = formatServerReport(
      instance(),
      serverFacts({
        docker: {
          present: true, usable: true, networks: [],
          containers: Array.from({ length: 40 }, (_, i) => ({
            name: `app-${i}`, image: `img/app-${i}:latest`, state: "running", ports: "",
          })),
        },
        services: Array.from({ length: 60 }, (_, i) => `unite-${i}.service`),
      }),
      classification({ regime: "docker" })
    )

    expect(rapport.length).toBeLessThan(3000)
    expect(rapport).toMatch(/40 conteneurs|30 autres|…/)
  })
})
