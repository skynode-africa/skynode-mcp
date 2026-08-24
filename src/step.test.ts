import { describe, expect, it } from "vitest"

import type { PlanStep } from "./plan-types.js"
import type { StepContext } from "./step.js"
import { TYPES_IMPLEMENTES, isReversible, recipeFor, verifieConformiteScript } from "./step.js"

/**
 * Une étape valide par type — les mêmes valeurs que `plan-types.ts` accepte, pas des
 * approximations : une recette éprouvée sur une étape que le validateur refuserait ne
 * prouve rien de ce que l'exécuteur lui donnera vraiment.
 *
 * Dépôt public : le domaine est en `exemple.ci`, réservé aux exemples.
 */
const ETAPES: { [T in PlanStep["type"]]: Extract<PlanStep, { type: T }> } = {
  "host.prepare": { type: "host.prepare", swap_mo: 2048 },
  "host.install_docker": { type: "host.install_docker" },
  "proxy.caddy.install": { type: "proxy.caddy.install" },
  "build.generate_dockerfile": {
    type: "build.generate_dockerfile",
    famille: "node",
    version: "22",
    gestionnaire: "pnpm",
    sortie: "server",
    port: 3000,
  },
  "build.image": { type: "build.image", source: { type: "local", path: "." }, tag: "boutique:latest" },
  "env.write": { type: "env.write", depuis: ".env.production" },
  "app.run": { type: "app.run", port_interne: 3000, reseau: "skynode" },
  "proxy.caddy.site": { type: "proxy.caddy.site", domaine: "boutique.exemple.ci" },
  "state.record": { type: "state.record" },
}

const etapeDe = (type: PlanStep["type"]): PlanStep => ETAPES[type]

const contexte = (): StepContext => ({
  application: "boutique",
  projectRoot: "/home/dev/boutique",
  workDir: "/opt/skynode/work/boutique",
})

const TOUS_LES_TYPES = Object.keys(ETAPES) as PlanStep["type"][]

describe("recipeFor", () => {
  /** Le vocabulaire fermé du plan doit avoir une recette pour chacun de ses neuf types. */
  it.each(TOUS_LES_TYPES)("a une recette pour %s", (type) => {
    expect(() => recipeFor(type)).not.toThrow()
  })

  /**
   * Une recette manquante doit lever à la construction, pas produire un script vide qui
   * ferait croire l'étape appliquée.
   */
  it("lève sur un type sans recette", () => {
    expect(() => recipeFor("shell.run" as never)).toThrow(/recette/i)
  })

  /**
   * `RECIPES` est un objet ordinaire : sans garde, `recipeFor("toString")` rendrait la
   * méthode héritée d'`Object.prototype` et l'exécuteur croirait tenir une recette.
   */
  it("lève sur une propriété héritée d'Object.prototype", () => {
    expect(() => recipeFor("toString" as never)).toThrow(/recette/i)
    expect(() => recipeFor("constructor" as never)).toThrow(/recette/i)
  })

  /**
   * Une recette encore à écrire refuse d'agir plutôt que de rendre un script vide : un
   * script vide sortirait sans marqueur de fin et se lirait comme une connexion coupée.
   */
  it.each(TOUS_LES_TYPES.filter((t) => !TYPES_IMPLEMENTES.includes(t)))(
    "le script de %s, non encore écrit, lève en nommant sa tâche",
    (type) => {
      expect(() => recipeFor(type).script(etapeDe(type), contexte())).toThrow(/à écrire.*tâche \d/s)
    }
  )
})

describe("undoScript", () => {
  /**
   * Une étape irréversible répond `null` dès maintenant : c'est un fait définitif, pas un
   * morceau qui reste à écrire.
   */
  it.each(TOUS_LES_TYPES.filter((t) => !isReversible(etapeDe(t))))(
    "%s rend null, et le rendra toujours",
    (type) => {
      expect(recipeFor(type).undoScript(etapeDe(type), contexte())).toBeNull()
    }
  )

  /**
   * Une étape réversible dont l'annulation n'est pas écrite lève. Répondre `null` la ferait
   * passer pour irréversible et contredirait `isReversible` : l'exécuteur annoncerait un
   * retour arrière complet qu'il ne ferait pas.
   */
  it.each(TOUS_LES_TYPES.filter((t) => isReversible(etapeDe(t)) && !TYPES_IMPLEMENTES.includes(t)))(
    "%s, réversible mais non écrite, lève au lieu de rendre null",
    (type) => {
      expect(() => recipeFor(type).undoScript(etapeDe(type), contexte())).toThrow(/à écrire/)
    }
  )
})

describe("les scripts produits", () => {
  /**
   * L'invariant n°1 du jalon, et les trois autres contrôles du harnais. `TYPES_IMPLEMENTES`
   * est vide en tâche 2 : `it.each([])` n'enregistrerait alors aucun test et la suite se
   * tairait au lieu de dire où elle en est.
   */
  if (TYPES_IMPLEMENTES.length === 0) {
    it("aucune recette n'est encore écrite", () => {
      expect(TYPES_IMPLEMENTES).toHaveLength(0)
    })
  } else {
    it.each(TYPES_IMPLEMENTES)("le script de %s passe les quatre contrôles", (type) => {
      expect(() => verifieConformiteScript(type, etapeDe(type), contexte())).not.toThrow()
    })
  }

  /**
   * Le harnais lui-même doit mordre : un contrôle qui laisse tout passer est pire qu'aucun
   * contrôle, puisqu'il fait croire que les scripts sont relus. On le vérifie donc sur des
   * scripts fautifs fabriqués ici, faute de recette réelle à lui soumettre en tâche 2.
   */
  const fautifs: ReadonlyArray<readonly [string, string]> = [
    ["sans marqueur de fin", "printf 'step.outcome\\tunchanged\\n'"],
    ["avec un bashisme", "if [[ -d /srv ]]; then :; fi\nprintf 'unchanged step.end\\n'"],
    ["avec local", "f() {\n  local x=1\n}\nprintf 'unchanged step.end\\n'"],
    ["sans garde d'idempotence", "printf 'step.outcome\\tapplied\\nstep.end\\t1\\n'"],
  ]

  it.each(fautifs)("le harnais refuse un script %s", (_nom, script) => {
    // Le harnais lit la recette du tableau ; on lui en substitue une le temps du test, sans
    // toucher au module — c'est le seul moyen de l'éprouver avant qu'une recette existe.
    const recette = recipeFor("state.record")
    const original = recette.script
    recette.script = () => script

    try {
      expect(() => verifieConformiteScript("state.record", etapeDe("state.record"), contexte())).toThrow(
        /contrôle/
      )
    } finally {
      recette.script = original
    }
  })

  it("le harnais accepte un script conforme", () => {
    const recette = recipeFor("state.record")
    const original = recette.script
    recette.script = () =>
      ["printf 'step.outcome\\t%s\\n' unchanged", "printf 'step.end\\t1\\n'"].join("\n")

    try {
      expect(() =>
        verifieConformiteScript("state.record", etapeDe("state.record"), contexte())
      ).not.toThrow()
    } finally {
      recette.script = original
    }
  })
})

describe("isReversible", () => {
  it.each([
    ["host.prepare", false],
    ["host.install_docker", false],
    ["proxy.caddy.install", true],
    ["build.generate_dockerfile", true],
    ["build.image", true],
    ["env.write", true],
    ["app.run", true],
    ["proxy.caddy.site", true],
    ["state.record", true],
  ] as const)("%s → %s", (type, attendu) => {
    expect(isReversible(etapeDe(type))).toBe(attendu)
  })

  /** La réversibilité doit être déclarée pour les neuf types, sans trou ni type oublié. */
  it("couvre le vocabulaire entier", () => {
    for (const type of TOUS_LES_TYPES) {
      expect(typeof isReversible(etapeDe(type))).toBe("boolean")
    }
  })
})
