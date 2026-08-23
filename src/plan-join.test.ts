import { describe, expect, it } from "vitest"

import type { Instance } from "./api.js"
import { composePlan, type ComposeOptions } from "./plan-compose.js"
import { parsePlan } from "./plan-types.js"
import type { ProjectFacts } from "./project-analyze.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"
import { classify } from "./regime.js"
import { validatePlan } from "./plan-validate.js"

/**
 * L'invariant central de la branche : `composePlan` et `validatePlan` doivent s'accorder
 * sur le même espace de valeurs. Soit le composeur refuse une entrée ou un état qu'il ne
 * peut pas transformer en plan sûr, soit le plan qu'il compose passe la validation —
 * **jamais** un plan composé qui échoue à sa propre validation.
 *
 * La revue finale a trouvé cet invariant rompu 832 fois sur 2 688 compositions balayées,
 * sur deux axes que ce fichier couvre chacun : les entrées du développeur (domaine,
 * fichier d'environnement) et l'état du serveur constaté (Docker inutilisable, Caddy
 * disparu). Les quatre tests nominaux de `plan-compose.test.ts` et `plan-validate.test.ts`
 * ne balayaient qu'un seul point par axe ; celui-ci balaie les deux systématiquement.
 */

type Deep<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K]
}

/** Un projet Next.js en sortie standalone, sans Dockerfile — repris de `plan-compose.test.ts`. */
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

/** Une Ubuntu 24.04 en root, saine et vierge — repris de `plan-compose.test.ts`. */
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

const baseOptions: ComposeOptions = { application: "boutique", domaine: "boutique.exemple.ci" }

/**
 * Axe A — les entrées du développeur. Sept variantes ordinaires, chacune censée être
 * refusée par `composePlan` avant même de composer une étape, sur le motif du
 * validateur (`plan-rules.ts`) : c'est lui qui fait foi.
 */
const AXIS_A: { nom: string; options: ComposeOptions }[] = [
  { nom: "domaine en majuscules", options: { ...baseOptions, domaine: "Boutique.Exemple.CI" } },
  { nom: "domaine à TLD numérique", options: { ...baseOptions, domaine: "x.exemple.123" } },
  { nom: "domaine à TLD d'une lettre", options: { ...baseOptions, domaine: "x.exemple.c" } },
  {
    nom: "fichier d'environnement qui remonte hors du projet",
    options: { ...baseOptions, envFile: "../../root/.ssh/id_rsa" },
  },
  { nom: "fichier d'environnement en chemin absolu", options: { ...baseOptions, envFile: "/etc/passwd" } },
  { nom: "fichier d'environnement avec un espace", options: { ...baseOptions, envFile: "mon .env" } },
  {
    nom: "fichier d'environnement avec un saut de ligne",
    options: { ...baseOptions, envFile: "mon\n.env" },
  },
]

/**
 * Axe B — l'état du serveur. Quatre états où `classify()` accorde `executable: true`
 * alors que le plan composé ne peut pas passer la validation tel quel : un Docker
 * injoignable (démon arrêté ou absent) ne se répare par aucune étape du vocabulaire, un
 * Caddy disparu en régime `skynode` se répare par une étape d'équipement.
 */
const AXIS_B: { nom: string; facts: ServerFacts }[] = [
  {
    nom: "skynode.present, démon Docker arrêté",
    facts: facts({
      skynode: { present: true, raw: "{}" },
      docker: {
        present: true,
        usable: false,
        version: "20.10",
        compose: true,
        containers: [{ name: "skynode-caddy", image: "caddy:2", state: "running", ports: "" }],
        networks: [],
      },
    }),
  },
  {
    nom: "skynode.present, Docker absent",
    facts: facts({ skynode: { present: true, raw: "{}" } }),
  },
  {
    nom: "skynode.present, conteneur skynode-caddy supprimé",
    facts: facts({
      skynode: { present: true, raw: "{}" },
      docker: { present: true, usable: true, version: "20.10", compose: true, containers: [], networks: [] },
    }),
  },
  {
    nom: "docker.present, usable: false",
    facts: facts({
      docker: { present: true, usable: false, version: "20.10", compose: true, containers: [], networks: [] },
    }),
  },
]

/** Le résultat d'agrément entre les deux modules, pour un couple (entrée, état). */
type Agreement = { refused: true } | { refused: false; validated: boolean }

function checkAgreement(
  proj: ProjectFacts,
  srv: ServerFacts,
  classification: Classification,
  options: ComposeOptions
): Agreement {
  const composed = composePlan(instance(), proj, srv, classification, options)
  if (!composed.ok) return { refused: true }

  const validation = validatePlan(composed.plan, srv, classification)
  return { refused: false, validated: validation.ok }
}

describe("jointure composeur/validateur — balayage", () => {
  const vierge = facts()
  const vierdeClassification = classify(vierge)

  /**
   * Axe A seul, sur un serveur sain : les sept entrées doivent être refusées par
   * `composePlan` lui-même, avec un message français exploitable — jamais un plan
   * composé, jamais un renvoi vers github.com/…/issues (`tools.ts`).
   */
  it.each(AXIS_A)("axe A — refuse : $nom", ({ options }) => {
    const composed = composePlan(instance(), project(), vierge, vierdeClassification, options)

    expect(composed.ok).toBe(false)
    if (composed.ok) return
    expect(composed.because.toLowerCase()).not.toMatch(/skynode.*cassé|défaut de skynode/)
  })

  /**
   * Axe B seul, avec des entrées valides : les quatre états doivent soit être refusés
   * (Docker injoignable, ou absent alors que `skynode.present`), soit produire un plan
   * qui passe la validation (Caddy manquant en régime `skynode`, réparé par une étape
   * d'équipement) — jamais un plan qui échoue.
   */
  it.each(AXIS_B)("axe B — accord composeur/validateur : $nom", ({ facts: srv }) => {
    const classification = classify(srv)
    const agreement = checkAgreement(project(), srv, classification, baseOptions)

    if (!agreement.refused) {
      expect(agreement.validated).toBe(true)
    }
  })

  /** Verrouille le cas d'équipement explicitement demandé par la revue : Caddy manquant
   * en régime `skynode` compose, plutôt que refuser, et le plan produit est valide. */
  it("répare Caddy en régime skynode plutôt que de refuser", () => {
    const srv = facts({
      skynode: { present: true, raw: "{}" },
      docker: { present: true, usable: true, version: "20.10", compose: true, containers: [], networks: [] },
    })
    const classification = classify(srv)
    const composed = composePlan(instance(), project(), srv, classification, baseOptions)

    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.plan.etapes.map((e) => e.type)).toContain("proxy.caddy.install")
    expect(validatePlan(composed.plan, srv, classification).ok).toBe(true)
    expect(() => parsePlan(JSON.parse(JSON.stringify(composed.plan)))).not.toThrow()
  })

  /** Verrouille les trois refus explicitement demandés par la revue : aucune étape du
   * vocabulaire ne répare un Docker injoignable ou absent. */
  it.each([AXIS_B[0], AXIS_B[1], AXIS_B[3]])("refuse plutôt que de composer un plan mort-né : $nom", ({ facts: srv }) => {
    const classification = classify(srv)
    const composed = composePlan(instance(), project(), srv, classification, baseOptions)

    expect(composed.ok).toBe(false)
  })

  /**
   * Le balayage complet : le produit cartésien de l'axe A (sept entrées, plus une
   * entrée valide de référence) et de l'axe B (quatre états, plus un état sain de
   * référence) — 40 combinaisons. Sur chacune, l'invariant tenu ci-dessus doit rester
   * vrai : jamais de plan composé qui échoue à la validation.
   */
  it("balaie le produit cartésien des deux axes sans jamais laisser passer une jointure brisée", () => {
    const entrees = [{ nom: "entrée valide de référence", options: baseOptions }, ...AXIS_A]
    const etats = [{ nom: "état sain de référence", facts: vierge }, ...AXIS_B]

    let refusees = 0
    let composeesValidees = 0
    let composeesEchouees = 0

    for (const entree of entrees) {
      for (const etat of etats) {
        const classification = classify(etat.facts)
        const agreement = checkAgreement(project(), etat.facts, classification, entree.options)

        if (agreement.refused) {
          refusees++
        } else if (agreement.validated) {
          composeesValidees++
        } else {
          composeesEchouees++
        }
      }
    }

    expect(composeesEchouees).toBe(0)
    expect(refusees + composeesValidees).toBe(entrees.length * etats.length)
  })
})
