import { describe, expect, it } from "vitest"

import { formatPlan, formatRefusal, formatViolations } from "./plan-render.js"
import type { Plan } from "./plan-types.js"
import { validatePlan } from "./plan-validate.js"
import type { ServerFacts } from "./probe.js"
import { classify } from "./regime.js"

/**
 * Un plan portant **les neuf étapes**, contrairement à celui de la tâche 5 qui n'en a que
 * sept : le test du rendu les parcourt toutes, et un plan incomplet le ferait échouer sur
 * les deux manquantes sans que la cause soit lisible.
 */
function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    id: "plan_01K7Z8Q2",
    serveur: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    regime: "vierge",
    empreinte_etat: "sha256:" + "a".repeat(64),
    application: "boutique",
    resume: "Installer Docker et Caddy, construire l’image depuis un Dockerfile généré, "
      + "publier sur https://boutique.exemple.ci",
    etapes: [
      { type: "host.prepare", swap_mo: 2048 },
      { type: "host.install_docker" },
      { type: "proxy.caddy.install" },
      { type: "build.generate_dockerfile", famille: "node", version: "22",
        gestionnaire: "pnpm", sortie: "standalone", port: 3000 },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "env.write", depuis: ".env.production" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "proxy.caddy.site", domaine: "boutique.exemple.ci" },
      { type: "state.record" },
    ],
    hors_perimetre: ["aucune sauvegarde n’est configurée"],
    reversible: true,
    ...overrides,
  } as Plan
}

describe("formatPlan", () => {
  it("met le résumé en première ligne", () => {
    expect(formatPlan(plan()).split("\n")[0]).toContain("Installer Docker")
  })

  /** Un développeur doit reconnaître ce qui va se passer, pas décoder une énumération. */
  it.each([
    ["host.prepare", /pare-feu|utilisateur|durci/i],
    ["host.install_docker", /Docker/],
    ["proxy.caddy.install", /Caddy/],
    ["build.generate_dockerfile", /Dockerfile/],
    ["build.image", /image/i],
    ["env.write", /environnement|variables/i],
    ["app.run", /démarrer|conteneur/i],
    ["proxy.caddy.site", /HTTPS|certificat|443/],
    ["state.record", /état/i],
  ])("rend %s en français, sans son nom de type", (type, attendu) => {
    const rendu = formatPlan(plan())

    expect(rendu).toMatch(attendu)
    expect(rendu).not.toContain(type)
  })

  it("numérote les étapes dans l'ordre d'exécution", () => {
    const rendu = formatPlan(plan())

    expect(rendu).toMatch(/^\s*1\.\s/m)
    expect(rendu.indexOf("1.")).toBeLessThan(rendu.indexOf("2."))
  })

  it("nomme le domaine et l'application", () => {
    const rendu = formatPlan(plan())

    expect(rendu).toContain("boutique.exemple.ci")
    expect(rendu).toContain("boutique")
  })

  /**
   * L'invariant repris du jalon 2 : le nom du fichier suffit à décider, sa valeur
   * ferait transiter les secrets du client par le contexte de l'agent.
   */
  it("nomme le fichier d'environnement sans jamais son contenu", () => {
    const p = plan({ etapes: [
      { type: "host.install_docker" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "env.write", depuis: ".env.production" },
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "state.record" },
    ] as never })

    const rendu = formatPlan(p)
    expect(rendu).toContain(".env.production")
    expect(rendu).toMatch(/valeurs? ne (sont|seront)|sans (lire|afficher)/i)
  })

  it("rend le hors-périmètre après la dernière étape", () => {
    const rendu = formatPlan(plan())
    const lignes = rendu.split("\n")

    const derniereEtape = lignes.findLastIndex((l) => /^\s*\d+\.\s/.test(l))
    const horsPerimetre = lignes.findIndex((l) => /sauvegarde/i.test(l))

    expect(horsPerimetre).toBeGreaterThan(derniereEtape)
  })

  it("reste sous 2 000 caractères sur un plan complet", () => {
    expect(formatPlan(plan()).length).toBeLessThan(2000)
  })

  it("dit qu'un plan irréversible l'est", () => {
    expect(formatPlan(plan({ reversible: false }))).toMatch(/irréversible|ne pourra pas être annulé/i)
  })
})

describe("formatRefusal", () => {
  /** Un refus est un constat, pas une panne — même règle qu'au jalon 2. */
  it("rend le motif puis la marche à suivre, sans vocabulaire de panne", () => {
    const rendu = formatRefusal("aaPanel est installé.", ["voie 1", "voie 2", "voie 3"])

    expect(rendu).toContain("aaPanel")
    expect(rendu).toContain("voie 1")
    expect(rendu.indexOf("aaPanel")).toBeLessThan(rendu.indexOf("voie 1"))
    expect(rendu).not.toMatch(/erreur|échec|impossible/i)
  })

  it("reste lisible sans marche à suivre", () => {
    expect(formatRefusal("Aucun port n'a pu être déduit.", [])).toContain("port")
  })
})

describe("formatViolations", () => {
  it("groupe par règle et dit quoi corriger", () => {
    const rendu = formatViolations([
      { regle: "bornes", message: "L'étiquette d'image doit commencer par « skynode/ ».", etape: 1 },
      { regle: "dependances", message: "app.run vient avant build.image." },
    ])

    expect(rendu).toContain("skynode/")
    expect(rendu).toMatch(/étape 2/i)  // index 1 → étape 2 pour un humain
  })

  it("ne parle pas d'erreur interne", () => {
    const rendu = formatViolations([{ regle: "empreinte", message: "La machine a changé." }])

    expect(rendu).not.toMatch(/exception|stack|undefined/i)
  })
})

/**
 * `formatViolations` contre de **vrais** messages de `plan-validate.ts`, pas contre les
 * fixtures écrites à la main ci-dessus : ces messages embarquent déjà leur propre
 * référence d'étape, en base 0 (`étape 0 (host.install_docker) contredit…`) — un défaut
 * que les fixtures du brief, volontairement dépourvues de ce préfixe, ne pouvaient pas
 * révéler. Sans ce test, un plan fautif rendrait deux numéros d'étape pour un seul fait.
 *
 * Une Ubuntu 24.04 en root, Docker déjà présent et utilisable : le régime constaté est
 * "docker", exécutable, sans quoi `validatePlan` refuserait le plan sur le régime avant
 * même d'atteindre la violation qu'on veut isoler ici.
 */
function serverFacts(): ServerFacts {
  return {
    host: {
      user: "root",
      uid: 0,
      arch: "x86_64",
      kernel: "6.8.0",
      osId: "ubuntu",
      osVersion: "24.04",
      osName: "Ubuntu 24.04.1 LTS",
    },
    resources: { cpu: 4, memoryMb: 7943, swapMb: 0, diskUsePercent: 8 },
    access: { elevate: "root" },
    docker: { present: true, usable: true, version: "27.0.0", compose: true, containers: [], networks: [] },
    podmanPresent: false,
    binaries: [],
    listeners: [],
    services: [],
    panel: null,
    skynode: { present: false, raw: null },
  }
}

/** Un plan fautif d'une seule façon à la fois, pour isoler la violation qu'on veut lire. */
function faultyPlan(etapes: Plan["etapes"]): Plan {
  const facts = serverFacts()
  const classification = classify(facts)

  return {
    version: 1,
    id: "plan_01K7Z8Q2",
    serveur: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    regime: classification.regime,
    // La valeur exacte n'importe pas ici : seule la forme du texte de violation compte,
    // pas la règle "empreinte" — non déclenchée volontairement par ces tests.
    empreinte_etat: "sha256:" + "a".repeat(64),
    application: "boutique",
    resume: "Plan de test, délibérément fautif.",
    etapes,
    hors_perimetre: [],
    reversible: true,
  }
}

function renderedViolations(etapes: Plan["etapes"]): { rendu: string; violations: string[] } {
  const facts = serverFacts()
  const classification = classify(facts)
  const result = validatePlan(faultyPlan(etapes), facts, classification)

  if (result.ok) throw new Error("le plan de test aurait dû être refusé")

  return { rendu: formatViolations(result.violations), violations: result.violations.map((v) => v.message) }
}

describe("formatViolations avec de vraies violations de plan-validate.ts", () => {
  it("rend une dépendance violée avec un seul numéro d'étape", () => {
    // app.run avant build.image : viole l'ordre, pas les bornes ni la contradiction.
    const { rendu } = renderedViolations([
      { type: "app.run", port_interne: 3000, reseau: "skynode" },
      { type: "build.image", source: { type: "local", path: "." }, tag: "skynode/boutique" },
      { type: "state.record" },
    ] as never)

    expect(rendu).toContain("étape 1")
    expect(rendu).not.toContain("étape 0")
    expect(rendu.match(/étape \d+/g)).toHaveLength(1)
  })

  it("rend une borne dépassée avec un seul numéro d'étape", () => {
    // Étiquette hors du périmètre "skynode/…" : viole les bornes, pas les dépendances.
    const { rendu } = renderedViolations([
      { type: "build.image", source: { type: "local", path: "." }, tag: "registre-tiers/boutique" },
      { type: "state.record" },
    ] as never)

    expect(rendu).toContain("étape 1")
    expect(rendu).not.toContain("étape 0")
    expect(rendu.match(/étape \d+/g)).toHaveLength(1)
  })

  it("rend une contradiction avec un seul numéro d'étape", () => {
    // Docker est déjà présent et utilisable dans `serverFacts()` : le réinstaller contredit l'état constaté.
    const { rendu } = renderedViolations([
      { type: "host.install_docker" },
      { type: "state.record" },
    ] as never)

    expect(rendu).toContain("étape 1")
    expect(rendu).not.toContain("étape 0")
    expect(rendu.match(/étape \d+/g)).toHaveLength(1)
  })

  /**
   * Le repli : un message qui ne commence pas par le gabarit littéral `étape N (...)`
   * garde son traitement d'origine, un seul préfixe ajouté devant — le comportement
   * que les tests `formatViolations` ci-dessus, écrits à la main, vérifiaient déjà,
   * mais qu'il faut préserver explicitement une fois `withEtape` devenu conditionnel.
   */
  it("garde le préfixe ajouté quand le message ne porte pas le gabarit attendu", () => {
    const rendu = formatViolations([
      { regle: "bornes", message: "Message composé à la main, sans préfixe intégré.", etape: 3 },
    ])

    expect(rendu).toContain("étape 4 : Message composé à la main, sans préfixe intégré.")
  })
})
