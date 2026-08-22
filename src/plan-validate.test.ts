import { describe, expect, it } from "vitest"

import { validatePlan } from "./plan-validate.js"
import type { Plan } from "./plan-types.js"
import { computeFingerprint } from "./fingerprint.js"
import type { ProjectFacts } from "./project-analyze.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"
import type { Instance } from "./api.js"

/*
  Quatre constructeurs recopiés : `facts` de la tâche 2, `classification`, `project` et
  `instance` de la tâche 4. Repris tels quels de `plan-compose.test.ts` — ce fichier
  n'exporte rien, et Vitest exécuterait sa suite une seconde fois si on l'importait.
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

/** Un plan valide de bout en bout, dont chaque test n'écarte qu'un aspect. */
function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    id: "plan_01K7Z8Q2",
    serveur: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    regime: "vierge",
    empreinte_etat: computeFingerprint(facts(), classification()),
    application: "boutique",
    resume: "Installer Docker et Caddy, construire l'image, publier en HTTPS.",
    etapes: [
      { type: "host.prepare", swap_mo: 0 },
      { type: "host.install_docker" },
      { type: "proxy.caddy.install" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "proxy.caddy.site", domaine: "boutique.exemple.ci" },
      { type: "state.record" },
    ],
    hors_perimetre: ["aucune sauvegarde n'est configurée"],
    reversible: true,
    ...overrides,
  } as Plan
}

/** Rend les règles enfreintes, pour comparer sans dépendre du texte des messages. */
function regles(plan: Plan, f = facts(), c = classification()): string[] {
  const v = validatePlan(plan, f, c)
  return v.ok ? [] : v.violations.map((x) => x.regle)
}

describe("validatePlan — ce qui passe", () => {
  it("accepte un plan cohérent", () => {
    expect(validatePlan(plan(), facts(), classification())).toEqual({ ok: true })
  })

  it("accepte un plan skynode réduit à l'essentiel", () => {
    const f = facts({
      skynode: { present: true, raw: "{}" },
      docker: { present: true, usable: true, version: "", compose: true, networks: [],
                containers: [{ name: "skynode-caddy", image: "caddy:2", state: "running", ports: "" }] },
    })
    const c = classification({ regime: "skynode" })

    const p = plan({
      regime: "skynode",
      empreinte_etat: computeFingerprint(f, c),
      etapes: [
        { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
        { type: "app.run", port_interne: 3000, reseau: "skynode" },
        { type: "state.record" },
      ],
    })

    expect(validatePlan(p, f, c).ok).toBe(true)
  })
})

describe("validatePlan — règle 2 : l'empreinte d'état", () => {
  /**
   * Quelqu'un a modifié la machine entre la proposition et l'application. Sur un serveur
   * qu'un humain administre aussi, c'est un cas courant, pas une hypothèse d'école.
   */
  it("refuse un plan dont l'empreinte ne correspond plus", () => {
    expect(regles(plan({ empreinte_etat: "sha256:" + "b".repeat(64) }))).toContain("empreinte")
  })

  it("refuse quand la machine a changé sous le plan", () => {
    const apres = facts({ docker: { present: true, usable: true, version: "", compose: true,
                                    containers: [], networks: [] } })

    expect(regles(plan(), apres, classification({ regime: "docker" }))).toContain("empreinte")
  })
})

describe("validatePlan — règle 3 : l'ordre des dépendances", () => {
  it.each([
    ["app.run avant build.image", [
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "state.record" },
    ]],
    ["proxy.caddy.site avant que Caddy existe", [
      { type: "host.install_docker" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "proxy.caddy.site", domaine: "x.exemple.ci" },
      { type: "state.record" },
    ]],
    ["build.image avant Docker sur un serveur vierge", [
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "host.install_docker" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "state.record" },
    ]],
    ["env.write après app.run", [
      { type: "host.install_docker" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "env.write", depuis: ".env.production" },
      { type: "state.record" },
    ]],
    ["proxy.caddy.site sans app.run", [
      { type: "host.install_docker" },
      { type: "proxy.caddy.install" },
      { type: "proxy.caddy.site", domaine: "x.exemple.ci" },
      { type: "state.record" },
    ]],
    ["state.record ailleurs qu'en dernier", [
      { type: "state.record" },
      { type: "host.install_docker" },
    ]],
  ] as const)("refuse %s", (_nom, etapes) => {
    expect(regles(plan({ etapes: etapes as never }))).toContain("dependances")
  })

  /** L'inverse compte autant : le validateur ne doit pas refuser un ordre légitime. */
  it("accepte que host.prepare vienne après host.install_docker", () => {
    const p = plan({ etapes: [
      { type: "host.install_docker" },
      { type: "host.prepare", swap_mo: 0 },
      { type: "proxy.caddy.install" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "state.record" },
    ] as never })

    expect(regles(p)).not.toContain("dependances")
  })
})

describe("validatePlan — règle 4 : la contradiction avec l'état observé", () => {
  it("refuse d'installer Caddy quand un tiers tient le port 80", () => {
    const f = facts({ listeners: [{ address: "0.0.0.0", port: 80, process: "nginx" }] })
    const c = classification({ regime: "occupe", executable: false })

    expect(regles(plan({ empreinte_etat: computeFingerprint(f, c) }), f, c)).toContain("contradiction")
  })

  it("refuse d'installer Docker sur une machine qui l'a déjà", () => {
    const f = facts({ docker: { present: true, usable: true, version: "", compose: true,
                                containers: [], networks: [] } })
    const c = classification({ regime: "docker" })

    expect(regles(plan({ regime: "docker", empreinte_etat: computeFingerprint(f, c) }), f, c))
      .toContain("contradiction")
  })
})

describe("validatePlan — règle 5 : le régime", () => {
  it.each(["panneau", "occupe", "inconnu"] as const)("refuse un plan en régime %s", (regime) => {
    const c = classification({ regime, executable: false })
    expect(regles(plan({ empreinte_etat: computeFingerprint(facts(), c) }), facts(), c))
      .toContain("regime")
  })

  it("refuse un plan dont le régime ne correspond pas à celui constaté", () => {
    const c = classification({ regime: "docker" })
    expect(regles(plan({ regime: "vierge", empreinte_etat: computeFingerprint(facts(), c) }), facts(), c))
      .toContain("regime")
  })
})

describe("validatePlan — règle 6 : les bornes", () => {
  it.each([
    ["un domaine qui n'en est pas un", { type: "proxy.caddy.site", domaine: "pas un domaine" }],
    ["un domaine avec un chemin", { type: "proxy.caddy.site", domaine: "x.ci/../etc" }],
    ["une étiquette hors de skynode/", { type: "build.image", source: { type: "local", path: "." }, tag: "evil/backdoor" }],
    ["une étiquette avec un registre tiers", { type: "build.image", source: { type: "local", path: "." }, tag: "docker.io/skynode/x" }],
    ["un chemin qui échappe à la racine", { type: "build.image", source: { type: "local", path: "../../etc" }, tag: "skynode/boutique" }],
    ["un chemin absolu", { type: "build.image", source: { type: "local", path: "/etc" }, tag: "skynode/boutique" }],
    ["un port hors plage", { type: "app.run", port_interne: 70000, reseau: "skynode" }],
    ["un réseau qui n'est pas le nôtre", { type: "app.run", port_interne: 3000, reseau: "host" }],
    ["un fichier d'environnement hors du projet", { type: "env.write", depuis: "../../root/.ssh/id_rsa" }],
  ] as const)("refuse %s", (_nom, etape) => {
    const etapes = [
      { type: "host.install_docker" },
      { type: "proxy.caddy.install" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      etape,
      { type: "state.record" },
    ]

    expect(regles(plan({ etapes: etapes as never }))).toContain("bornes")
  })

  /**
   * `reseau: "host"` mérite sa propre mention : il donnerait au conteneur la pile réseau
   * de la machine, donc l'accès à tout ce qui écoute sur la boucle locale — la base de
   * données d'un autre client comprise.
   */
  it("nomme le réseau hôte comme un refus, pas comme une préférence", () => {
    const v = validatePlan(
      plan({ etapes: [
        { type: "host.install_docker" },
        { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
        { type: "app.run", port_interne: 3000, reseau: "host" },
        { type: "state.record" },
      ] as never }),
      facts(), classification()
    )

    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.violations.map((x) => x.message).join(" ")).toMatch(/réseau/i)
  })
})

describe("validatePlan — la forme des refus", () => {
  it("rend toutes les violations, pas seulement la première", () => {
    const v = validatePlan(
      plan({ empreinte_etat: "sha256:" + "c".repeat(64),
             etapes: [
               { type: "app.run", port_interne: 70000, reseau: "host" },
               { type: "state.record" },
             ] as never }),
      facts(), classification()
    )

    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(new Set(v.violations.map((x) => x.regle)).size).toBeGreaterThan(1)
  })

  it("désigne l'étape fautive par son index", () => {
    const v = validatePlan(
      plan({ etapes: [
        { type: "host.install_docker" },
        { type: "build.image", source: { type: "local", path: "." }, tag: "evil/backdoor" },
        { type: "app.run", port_interne: 3000, reseau: "skynode" },
        { type: "state.record" },
      ] as never }),
      facts(), classification()
    )

    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.violations.find((x) => x.regle === "bornes")?.etape).toBe(1)
  })

  it("rend des messages français exploitables par un agent", () => {
    const v = validatePlan(plan({ empreinte_etat: "sha256:" + "d".repeat(64) }), facts(), classification())

    expect(v.ok).toBe(false)
    if (v.ok) return
    for (const violation of v.violations) {
      expect(violation.message).not.toMatch(/Expected|Invalid|undefined|\[object/)
      expect(violation.message.length).toBeGreaterThan(20)
    }
  })
})

describe("validatePlan — ce que le composeur produit passe toujours", () => {
  /**
   * La jointure entre les deux tâches. Si elle se rompt, le produit ne compose plus rien
   * d'applicable — et aucun test des deux modules pris isolément ne le montrerait.
   */
  it.each([
    ["vierge, Dockerfile généré", facts(), classification()],
    ["vierge, Dockerfile fourni", facts(), classification()],
    ["docker déjà présent",
      facts({ docker: { present: true, usable: true, version: "", compose: true,
                        containers: [], networks: [] } }),
      classification({ regime: "docker" })],
    ["skynode déjà en place",
      facts({ skynode: { present: true, raw: "{}" },
              docker: { present: true, usable: true, version: "", compose: true, networks: [],
                        containers: [{ name: "skynode-caddy", image: "caddy:2",
                                       state: "running", ports: "" }] } }),
      classification({ regime: "skynode" })],
  ])("accepte le plan composé pour %s", async (nom, f, c) => {
    // `project` et `instance` sont recopiés en tête de CE fichier — importer depuis
    // `plan-compose.test.ts` ne marcherait pas : il n'exporte rien, et Vitest
    // exécuterait sa suite une seconde fois.
    const { composePlan } = await import("./plan-compose.js")

    const result = composePlan(
      instance(),
      nom.includes("fourni") || c.regime === "skynode"
        ? project({ declared: { dockerfiles: ["Dockerfile"], composeFiles: [], services: [] } })
        : project(),
      f, c, { application: "boutique", domaine: "boutique.exemple.ci" }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(validatePlan(result.plan, f, c)).toEqual({ ok: true })
  })
})
