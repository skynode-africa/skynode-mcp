import { describe, expect, it } from "vitest"

import { composePlan } from "./plan-compose.js"
import { parsePlan } from "./plan-types.js"
import type { ProjectFacts } from "./project-analyze.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"
import type { Instance } from "./api.js"

/**
 * Quatre constructeurs, recopiés depuis `project-analyze.test.ts`, `regime.test.ts` et
 * `ssh.test.ts`. La duplication est assumée : un constructeur commun finit par porter les
 * besoins de tous les tests et cesse de dire, dans sa ligne d'appel, ce qui décide du cas.
 * `facts` est celui de la tâche 2, à reprendre tel quel.
 */
type Deep<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K]
}

/** Un projet Next.js en sortie standalone, sans Dockerfile — le cas nominal du jalon. */
function project(partial: Deep<ProjectFacts> = {}): ProjectFacts {
  return {
    root: "/projet",
    declared: { dockerfiles: [], composeFiles: [], services: [], ...partial.declared },
    runtime: {
      family: "node",
      evidence: ["package.json", "next.config.ts"],
      version: "22",
      packageManager: "pnpm",
      ...partial.runtime,
    },
    framework: partial.framework ?? "next",
    output: { mode: "standalone", directory: ".next/standalone", ...partial.output },
    port: { value: 3000, source: "port par défaut de Next.js", ...partial.port },
    env: { keys: [], files: [], hasLocalSecrets: false, ...partial.env },
    data: { engines: [], migrations: null, ...partial.data },
    weight: { files: 120, bytes: 2_400_000, tronque: false, ...partial.weight },
    warnings: partial.warnings ?? [],
    monorepo: { detected: false, packages: [], ...partial.monorepo },
  }
}

/**
 * Une Ubuntu 24.04 en root, saine et vierge — mêmes valeurs par défaut que
 * `regime.test.ts`, pour que les faits utilisés ici classent au même régime que
 * `classification()` en rend par défaut.
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

function classification(partial: Partial<Classification> = {}): Classification {
  return {
    regime: "vierge",
    executable: true,
    because: "aucun service web, Docker absent, Ubuntu 24.04 en root",
    blockers: [],
    guidance: [],
    ...partial,
  }
}

function instance(partial: Partial<Instance> = {}): Instance {
  return {
    id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    hostname: "boutique",
    status: "RUNNING",
    ipv4: "192.0.2.10",
    ipv6: null,
    region: "EU",
    osImage: "ubuntu-24-04",
    planId: "9a1b2c3d-4e5f-6789-abcd-ef0123456789",
    cycle: "MONTHLY",
    defaultUser: "root",
    nextRenewalAt: null,
    provisionedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  }
}

const options = { application: "boutique", domaine: "boutique.exemple.ci" }

describe("composePlan", () => {
  /** Le cas que Hostinger ne sait pas traiter : Next.js, VPS neuf, pas de Dockerfile. */
  it("compose le chemin complet sur un VPS vierge", () => {
    const result = composePlan(instance(), project(), facts(), classification(), options)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.plan.etapes.map((e) => e.type)).toEqual([
      "host.prepare",
      "host.install_docker",
      "proxy.caddy.install",
      "build.generate_dockerfile",
      "build.image",
      "app.run",
      "proxy.caddy.site",
      "state.record",
    ])
  })

  /** Le plan produit doit traverser son propre schéma — sinon il ne survivra pas au 3b. */
  it("produit un plan que parsePlan accepte", () => {
    const result = composePlan(instance(), project(), facts(), classification(), options)
    if (!result.ok) throw new Error("aurait dû composer")

    expect(() => parsePlan(JSON.parse(JSON.stringify(result.plan)))).not.toThrow()
  })

  /**
   * Le déterminisme est ce qui permet au jalon 3b de reconnaître un redéploiement
   * identique et de ne pas redemander une approbation. Sans lui, l'approbation
   * deviendrait un réflexe et cesserait de protéger.
   */
  it("rend exactement le même plan pour les mêmes faits", () => {
    const premier = composePlan(instance(), project(), facts(), classification(), options)
    for (let i = 0; i < 1000; i++) {
      const suivant = composePlan(instance(), project(), facts(), classification(), options)
      expect(JSON.stringify(suivant)).toBe(JSON.stringify(premier))
    }
  })

  /** Spec §5.3, première règle : le dépôt qui se déclare l'emporte sur toute déduction. */
  it("n'ajoute aucune génération quand le dépôt fournit un Dockerfile", () => {
    const result = composePlan(
      instance(),
      project({ declared: { dockerfiles: ["Dockerfile"], composeFiles: [], services: [] } }),
      facts(),
      classification(),
      options
    )
    if (!result.ok) throw new Error("aurait dû composer")

    expect(result.plan.etapes.map((e) => e.type)).not.toContain("build.generate_dockerfile")
    expect(result.plan.etapes.map((e) => e.type)).toContain("build.image")
  })

  it("n'installe pas Docker sur un serveur qui l'a déjà", () => {
    const result = composePlan(
      instance(),
      project(),
      facts({
        docker: { present: true, usable: true, version: "", compose: true, containers: [], networks: [] },
      }),
      classification({ regime: "docker" }),
      options
    )
    if (!result.ok) throw new Error("aurait dû composer")

    expect(result.plan.etapes.map((e) => e.type)).not.toContain("host.install_docker")
    expect(result.plan.etapes.map((e) => e.type)).toContain("proxy.caddy.install")
  })

  /** Spec §5.5 : une application SkyNode tourne déjà, les deux cohabitent via Caddy. */
  it("se limite à trois étapes utiles en régime skynode", () => {
    const result = composePlan(
      instance(),
      project({ declared: { dockerfiles: ["Dockerfile"], composeFiles: [], services: [] } }),
      facts({
        skynode: { present: true, raw: '{"recipe":1}' },
        docker: {
          present: true,
          usable: true,
          version: "",
          compose: true,
          networks: [],
          containers: [{ name: "skynode-caddy", image: "caddy:2", state: "running", ports: "" }],
        },
      }),
      classification({ regime: "skynode" }),
      options
    )
    if (!result.ok) throw new Error("aurait dû composer")

    expect(result.plan.etapes.map((e) => e.type)).toEqual([
      "build.image",
      "app.run",
      "proxy.caddy.site",
      "state.record",
    ])
  })

  it("refuse un régime non exécutable en reprenant le refus du jalon 2", () => {
    const result = composePlan(
      instance(),
      project(),
      facts({ panel: { id: "aapanel", path: "/www/server/panel" } }),
      classification({
        regime: "panneau",
        executable: false,
        because: "aaPanel est installé ; SkyNode ne modifiera pas sa configuration.",
        guidance: ["voie 1", "voie 2", "voie 3"],
      }),
      options
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.because).toMatch(/aaPanel/)
    expect(result.guidance).toEqual(["voie 1", "voie 2", "voie 3"])
  })

  /** Spec §5.3 : jamais une supposition. Le message doit dire ce qui a été cherché. */
  it("refuse sans improviser quand aucun gabarit ne convient", () => {
    const result = composePlan(
      instance(),
      project({
        runtime: { family: "php", evidence: ["composer.json"], version: null, packageManager: null },
      }),
      facts(),
      classification(),
      options
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.guidance.join(" ")).toMatch(/Dockerfile/)
    expect(result.because).toMatch(/php/i)
  })

  it("refuse un docker-compose.yml en disant que c'est pour plus tard", () => {
    const result = composePlan(
      instance(),
      project({ declared: { dockerfiles: [], composeFiles: ["docker-compose.yml"], services: [] } }),
      facts(),
      classification(),
      options
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.because).toMatch(/docker-compose/)
  })

  it("n'ajoute proxy.caddy.site que si un domaine est donné", () => {
    const sans = composePlan(instance(), project(), facts(), classification(), { application: "boutique" })
    if (!sans.ok) throw new Error("aurait dû composer")

    expect(sans.plan.etapes.map((e) => e.type)).not.toContain("proxy.caddy.site")
    expect(sans.plan.hors_perimetre.join(" ")).toMatch(/domaine|HTTPS/i)
  })

  it("ajoute env.write quand un fichier d'environnement est désigné", () => {
    const result = composePlan(instance(), project(), facts(), classification(), {
      ...options,
      envFile: ".env.production",
    })
    if (!result.ok) throw new Error("aurait dû composer")

    const env = result.plan.etapes.find((e) => e.type === "env.write")
    expect(env).toBeDefined()
    expect(result.plan.etapes.findIndex((e) => e.type === "env.write")).toBeLessThan(
      result.plan.etapes.findIndex((e) => e.type === "app.run")
    )
  })

  /**
   * Le champ existe précisément pour ne pas laisser un client supposer qu'une sauvegarde
   * est en place. Un add_database sans sauvegarde qui ne le déclare pas est un piège.
   */
  it("déclare l'absence de sauvegarde hors périmètre", () => {
    const result = composePlan(instance(), project(), facts(), classification(), options)
    if (!result.ok) throw new Error("aurait dû composer")

    expect(result.plan.hors_perimetre.join(" ")).toMatch(/sauvegarde/i)
  })

  it("refuse un nom d'application qui n'en est pas un", () => {
    for (const mauvais of ["Boutique", "../etc", "a b", "", "9lives", "x".repeat(40)]) {
      const result = composePlan(instance(), project(), facts(), classification(), { application: mauvais })
      expect(result.ok).toBe(false)
    }
  })

  it("refuse un domaine qui n'en est pas un", () => {
    for (const mauvais of ["pas un domaine", "http://x.ci", "-x.ci", "x..ci", "x.ci/path"]) {
      const result = composePlan(instance(), project(), facts(), classification(), {
        application: "boutique",
        domaine: mauvais,
      })
      expect(result.ok).toBe(false)
    }
  })

  it("reprend le port déduit du projet, et rien d'autre", () => {
    const result = composePlan(
      instance(),
      project({
        port: { value: 8080, source: "EXPOSE dans Dockerfile" },
        declared: { dockerfiles: ["Dockerfile"], composeFiles: [], services: [] },
      }),
      facts(),
      classification(),
      options
    )
    if (!result.ok) throw new Error("aurait dû composer")

    const run = result.plan.etapes.find((e) => e.type === "app.run")
    expect(run && "port_interne" in run ? run.port_interne : null).toBe(8080)
  })

  /** Sans port déduit, on ne devine pas : le composeur demande plutôt que de choisir. */
  it("refuse quand aucun port n'a pu être déduit", () => {
    const result = composePlan(
      instance(),
      project({ port: { value: null, source: "à confirmer avec le développeur" } }),
      facts(),
      classification(),
      options
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.guidance.join(" ")).toMatch(/port/i)
  })

  it("porte l'empreinte d'état de la machine constatée", () => {
    const result = composePlan(instance(), project(), facts(), classification(), options)
    if (!result.ok) throw new Error("aurait dû composer")

    expect(result.plan.empreinte_etat).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("écrit un résumé français qui nomme ce qui va se passer", () => {
    const result = composePlan(instance(), project(), facts(), classification(), options)
    if (!result.ok) throw new Error("aurait dû composer")

    expect(result.plan.resume).toMatch(/Docker/)
    expect(result.plan.resume).toMatch(/boutique\.exemple\.ci/)
    expect(result.plan.resume.length).toBeLessThan(500)
  })

  /**
   * Ajoutés en relecture : la seule branche du module qu'aucun des 18 tests du brief
   * n'exerçait. `generateDockerfile()` (tâche 3) valide `version` avec un motif
   * strictement numérique avant même de regarder la famille — une version fabriquée ici
   * exploserait au jalon 3b pour une raison que ce module aurait pu éviter.
   */
  it("refuse quand la version de Node n'a pas pu être déduite du dépôt", () => {
    const result = composePlan(
      instance(),
      project({
        runtime: { family: "node", evidence: ["package.json"], version: null, packageManager: "pnpm" },
      }),
      facts(),
      classification(),
      options
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.because).toMatch(/version/i)
    expect(result.because).toMatch(/node/i)
  })

  it("refuse quand la version de Python n'a pas pu être déduite du dépôt", () => {
    const result = composePlan(
      instance(),
      project({
        runtime: { family: "python", evidence: ["requirements.txt"], version: null, packageManager: null },
        output: { mode: "server", directory: null },
        framework: "fastapi",
      }),
      facts(),
      classification(),
      options
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.because).toMatch(/version/i)
    expect(result.because).toMatch(/python/i)
  })

  /**
   * Ajouté en relecture : les 18 tests du brief n'exerçaient `caddyAlreadyInstalled` qu'en
   * régime skynode, où le bloc entier est sauté avant de l'atteindre — redondant. Le cas
   * réel est ici : `facts.docker.present` peut être vrai sans que
   * `/etc/skynode/state.json` existe (régime docker), avec Caddy déjà posé à la main ou
   * par un déploiement SkyNode antérieur non retracé dans l'état.
   */
  it("ne réinstalle pas Caddy en régime docker quand le conteneur existe déjà", () => {
    const result = composePlan(
      instance(),
      project(),
      facts({
        docker: {
          present: true,
          usable: true,
          version: "",
          compose: true,
          networks: [],
          containers: [{ name: "skynode-caddy", image: "caddy:2", state: "running", ports: "" }],
        },
      }),
      classification({ regime: "docker" }),
      options
    )
    if (!result.ok) throw new Error("aurait dû composer")

    const types = result.plan.etapes.map((e) => e.type)
    expect(types).not.toContain("proxy.caddy.install")
    expect(types).not.toContain("host.install_docker")
    expect(types).toContain("host.prepare")
  })
})
