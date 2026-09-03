import { describe, expect, it } from "vitest"

import { generateDockerfile, generateDockerignore } from "./dockerfile.js"
import type { PlanStep } from "./plan-types.js"
import type { StepContext } from "./step.js"
import { recipeFor, verifieConformiteScript } from "./step.js"
import {
  IMAGES_CONSERVEES,
  LIGNES_JOURNAL,
  LONGUEUR_CONDENSAT,
  REPERTOIRE_STATIQUE_PAR_DEFAUT,
  depotImage,
  exigeSourceLocale,
  repertoireAPreserver,
} from "./steps-build.js"

/** Les mêmes valeurs que `plan-types.ts` accepte, jamais des approximations. */
const GENERATE: Extract<PlanStep, { type: "build.generate_dockerfile" }> = {
  type: "build.generate_dockerfile",
  famille: "node",
  version: "22",
  gestionnaire: "pnpm",
  sortie: "server",
  port: 3000,
}

const IMAGE: Extract<PlanStep, { type: "build.image" }> = {
  type: "build.image",
  source: { type: "local", path: "." },
  tag: "skynode/boutique",
}

const ctx = (): StepContext => ({
  application: "boutique",
  projectRoot: "/home/dev/boutique",
  workDir: "/opt/skynode/work/boutique",
})

const scriptGenerate = (etape: PlanStep = GENERATE, c: StepContext = ctx()): string =>
  recipeFor("build.generate_dockerfile").script(etape, c)
const undoGenerate = (etape: PlanStep = GENERATE, c: StepContext = ctx()): string =>
  recipeFor("build.generate_dockerfile").undoScript(etape, c) ?? ""
const scriptImage = (etape: PlanStep = IMAGE, c: StepContext = ctx()): string =>
  recipeFor("build.image").script(etape, c)
const undoImage = (etape: PlanStep = IMAGE, c: StepContext = ctx()): string =>
  recipeFor("build.image").undoScript(etape, c) ?? ""

describe("build.generate_dockerfile", () => {
  /**
   * Le Dockerfile est écrit dans l'arborescence TRANSFÉRÉE, jamais dans le dépôt du
   * client : SkyNode ne modifie pas les fichiers du développeur sans qu'il l'ait demandé.
   */
  it("écrit dans le répertoire de travail distant, pas dans le dépôt", () => {
    const s = scriptGenerate()

    expect(s).toContain(ctx().workDir)
    expect(s).not.toContain(ctx().projectRoot)
  })

  it("écrit aussi le .dockerignore", () => {
    expect(scriptGenerate()).toContain(".dockerignore")
  })

  /** Un Dockerfile fourni par le client n'est jamais écrasé. */
  it("ne remplace pas un Dockerfile existant", () => {
    expect(scriptGenerate()).toMatch(/unchanged/)
  })

  /**
   * La garde elle-même, pas seulement le mot `unchanged` : c'est la présence du fichier qui
   * décide, et l'écriture est dans la branche « sinon ».
   */
  it("teste la présence des deux fichiers avant d'écrire", () => {
    const s = scriptGenerate()

    expect(s).toContain("if [ -f '/opt/skynode/work/boutique/Dockerfile' ]; then")
    expect(s).toContain("if [ -f '/opt/skynode/work/boutique/.dockerignore' ]; then")
  })

  it("écrit le contenu du gabarit, pas un texte improvisé", () => {
    const s = scriptGenerate()

    expect(s).toContain(generateDockerfile({ ...GENERATE, repertoire: null }))
    expect(s).toContain(generateDockerignore(null))
  })

  it("refuse une arborescence non transférée au lieu de la créer", () => {
    expect(scriptGenerate()).toMatch(/if \[ ! -d '\/opt\/skynode\/work\/boutique' \]/)
  })

  /**
   * Le gabarit statique de Node recopie `dist`, que le `.dockerignore` exclut par ailleurs :
   * sans réintroduction, le fichier qui exclut et le Dockerfile qui recopie s'annulent.
   */
  it("réintroduit le répertoire que le gabarit statique recopie", () => {
    const statique: PlanStep = { ...GENERATE, sortie: "static" }
    const s = scriptGenerate(statique)

    expect(repertoireAPreserver(statique)).toBe(REPERTOIRE_STATIQUE_PAR_DEFAUT)
    expect(generateDockerfile({ ...GENERATE, sortie: "static", repertoire: null })).toContain(
      `/app/${REPERTOIRE_STATIQUE_PAR_DEFAUT}`
    )
    expect(s).toContain(`!${REPERTOIRE_STATIQUE_PAR_DEFAUT}`)
  })

  it("ne réintroduit rien pour une sortie serveur", () => {
    expect(repertoireAPreserver(GENERATE)).toBeNull()
    expect(scriptGenerate()).not.toContain("\n!dist")
  })

  it("ne réintroduit rien pour une étape d'un autre type", () => {
    expect(repertoireAPreserver(IMAGE)).toBeNull()
  })

  /**
   * L'annulation ne retire un fichier que s'il est exactement celui qu'on aurait écrit : un
   * Dockerfile du client se trouve dans la même arborescence, et l'effacer pour défaire notre
   * travail reviendrait à détruire le sien.
   */
  it("ne défait que ce qu'elle a écrit", () => {
    const u = undoGenerate()

    expect(u).toMatch(/cmp -s/)
    expect(u).toMatch(/rm -f '\/opt\/skynode\/work\/boutique\/Dockerfile'/)
    expect(u).toMatch(/rm -f '\/opt\/skynode\/work\/boutique\/\.dockerignore'/)
  })

  it("compare au contenu de référence, pas à une empreinte approximative", () => {
    expect(undoGenerate()).toContain(generateDockerfile({ ...GENERATE, repertoire: null }))
  })

  /** Le brouillon de comparaison porte le contenu du gabarit : hors du contexte de construction. */
  it("écrit son brouillon sous /etc/skynode, jamais dans l'arborescence de travail", () => {
    const u = undoGenerate()

    expect(u).toContain("/etc/skynode/.brouillon-dockerfile-defait")
    expect(u).not.toContain("/opt/skynode/work/boutique/.brouillon")
  })
})

describe("build.image", () => {
  it("étiquette avec le condensat du contenu transféré", () => {
    const s = scriptImage()

    expect(s).toMatch(/skynode\/boutique:/)
    expect(s).toMatch(/sha256sum/)
  })

  /**
   * Le condensat vient d'une commande du serveur, pas de `plan-rules.ts` : il entre dans une
   * ligne de commande jouée en root, et c'est ce bornage qui l'autorise (invariant n°1).
   */
  it("borne le condensat avant de l'interpoler", () => {
    const s = scriptImage()

    // Le bloc entier, pas seulement le motif : une branche laissée orpheline par un « case »
    // disparu passerait un contrôle qui ne cherche qu'une ligne, et ne bornerait plus rien.
    expect(s).toMatch(/case "\$sha" in\n[^\n]*""\|\*\[!0-9a-f\]\*\)[^\n]*\nesac/)
    expect(s).toContain(`[ "\${#sha}" -ne ${LONGUEUR_CONDENSAT} ]`)
  })

  /** Le tri doit être indépendant de la locale, sinon deux serveurs étiquettent différemment. */
  it("fixe l'ordre du condensat indépendamment de la locale", () => {
    expect(scriptImage()).toContain("LC_ALL=C sort -z")
  })

  /**
   * Les trois dernières images restent (spec §6.3) : c'est ce qui rend `rollback`
   * possible, et donc ce qui fait qu'un développeur ose déployer.
   */
  it("conserve les trois dernières images et élague le reste", () => {
    const s = scriptImage()

    // Le compte porte sur les identifiants distincts, pas sur les lignes : `docker images`
    // rend une ligne par étiquette, et plusieurs étiquettes désignent souvent une seule image.
    // La boucle entière, et pas seulement ses lignes prises séparément : la déduplication
    // apparaît aussi dans la boucle d'élagage, et une assertion par sous-chaîne resterait
    // vraie alors même que le comptage aurait cessé de dédupliquer.
    expect(s).toContain(
      [
        "for identifiant in $(docker images 'skynode/boutique' --format '{{.ID}}' 2>/dev/null); do",
        '  case " $recents " in *" $identifiant "*) continue ;; esac',
        '  recents="$recents $identifiant"',
        "  vus=$((vus + 1))",
        `  if [ "$vus" -ge ${IMAGES_CONSERVEES} ]; then break; fi`,
        "done",
      ].join("\n")
    )
    expect(IMAGES_CONSERVEES).toBe(3)
  })

  /**
   * Mesuré sur le banc : quatre passages dont seul le contexte de construction changeait ont
   * produit une image finale identique, donc un seul identifiant sous quatre étiquettes à la
   * même date. `docker images` ne pouvant plus les classer par date retombe sur l'ordre des
   * étiquettes, et l'élagage a retiré celle que l'étape venait d'annoncer construite.
   */
  it("ne peut pas élaguer l'image de ce passage", () => {
    expect(scriptImage()).toContain('if [ "$vieille" = "$image" ]; then continue; fi')
  })

  /**
   * Le filtre de la boucle d'élagage, pris avec ses voisines : c'est lui, et lui seul, qui
   * distingue une image à garder d'une image à retirer. Neutralisé, l'étape élaguerait tout
   * sauf l'image du passage — et le retour arrière n'aurait plus rien vers quoi revenir.
   */
  it("n'élague que les images absentes des plus récentes", () => {
    expect(scriptImage()).toContain(
      [
        '  if [ "$vieille" = "$image" ]; then continue; fi',
        '  case " $recents " in *" $identifiant "*) continue ;; esac',
      ].join("\n")
    )
  })

  /** Deux étiquettes d'une même image ne font pas deux retours arrière : on compte les images. */
  it("compte les identifiants d'image, pas les étiquettes", () => {
    const s = scriptImage()

    expect(s).toContain("--format '{{.ID}}'")
    expect(s).toContain("--format '{{.ID}}|{{.Repository}}:{{.Tag}}'")
    expect(s).toContain("identifiant=${couple%%|*}")
    expect(s).toContain("vieille=${couple#*|}")
  })

  /** L'élagage ne sort jamais du dépôt de cette application. */
  it("n'élague que les images de cette application", () => {
    const s = scriptImage()

    expect(s).toContain("docker images 'skynode/boutique'")
    expect(s).not.toMatch(/image prune/)
    expect(s).not.toMatch(/system prune/)
  })

  /** Un ménage raté ne fait pas échouer un déploiement réussi. */
  it("ne fait pas échouer l'étape sur un retrait d'image refusé", () => {
    expect(scriptImage()).toContain('if docker rmi "$vieille" >&2 2>&1; then')
  })

  it("borne le journal de construction", () => {
    const s = scriptImage()

    expect(s).toMatch(/tail -n \d+/)
    expect(s).toContain(`tail -n ${LIGNES_JOURNAL}`)
  })

  /**
   * Le journal explique la panne : il part sur `stderr`, que `runRemote` joint au
   * diagnostic. Dans `/dev/null`, il effacerait précisément ce qu'on cherche.
   */
  it("verse le journal sur stderr, jamais dans /dev/null", () => {
    const s = scriptImage()

    expect(s).toMatch(/tail -n \d+ '[^']+' >&2/)
    expect(s).not.toMatch(/tail -n \d+ [^\n]*\/dev\/null/)
  })

  /** La sortie standard porte le protocole d'étape : le journal ne doit jamais s'y mêler. */
  it("écrit le journal dans un fichier hors du contexte de construction", () => {
    const s = scriptImage()

    expect(s).toContain("/etc/skynode/.journal-construction-boutique")
    expect(s).not.toContain("/opt/skynode/work/boutique/.journal")
  })

  /** Rejouée sur un contenu identique, l'étape ne reconstruit rien. */
  it("sort en unchanged quand l'image du condensat existe déjà", () => {
    const s = scriptImage()

    expect(s).toContain('if docker image inspect "$image" >/dev/null 2>&1; then')
    expect(s).toMatch(/fin unchanged/)
    expect(s.indexOf("fin unchanged")).toBeLessThan(s.indexOf("docker build"))
  })

  it("se défait en retirant l'image construite, jamais les précédentes", () => {
    const u = undoImage()

    expect(u).toMatch(/rmi/)
    expect(u).not.toMatch(/image prune -a/)
    expect(u).toContain('docker rmi "$image"')
    expect(u).not.toMatch(/tail -n \+4/)
  })

  /** L'étiquette se recalcule depuis l'arborescence ; sans elle, on ne devine pas. */
  it("refuse de défaire à l'aveugle quand l'arborescence a disparu", () => {
    const u = undoImage()

    expect(u).toMatch(/if \[ ! -f '\/opt\/skynode\/work\/boutique\/Dockerfile' \]/)
    expect(u).toMatch(/docker images skynode\/boutique/)
  })

  it("ne défait rien quand l'image n'est pas là", () => {
    expect(undoImage()).toMatch(/fin unchanged/)
  })

  /** Docker est un prérequis de l'étape, pas quelque chose qu'elle installe. */
  it("constate Docker avant de construire", () => {
    expect(scriptImage()).toContain("docker info >/dev/null 2>&1")
  })

  it("refuse de construire sans Dockerfile plutôt que d'en improviser un", () => {
    expect(scriptImage()).toMatch(/if \[ ! -f '\/opt\/skynode\/work\/boutique\/Dockerfile' \]/)
  })

  /** L'image porte le nom de l'application, que `app.run` et `proxy.caddy.site` emploient. */
  it("étiquette dans le dépôt du produit", () => {
    expect(depotImage("boutique")).toBe("skynode/boutique")
    expect(scriptImage()).toContain("--label 'skynode.app=boutique'")
  })
})

describe("les garde-fous des deux recettes", () => {
  it.each([
    ["build.generate_dockerfile", scriptGenerate, undoGenerate],
    ["build.image", scriptImage, undoImage],
  ] as const)("%s refuse une étape d'un autre type", (type, s, u) => {
    const autre: PlanStep = { type: "state.record" }

    expect(() => s(autre)).toThrow(new RegExp(type.replace(".", "\\.")))
    expect(() => u(autre)).toThrow(new RegExp(type.replace(".", "\\.")))
  })

  it.each([
    ["build.generate_dockerfile", scriptGenerate, undoGenerate],
    ["build.image", scriptImage, undoImage],
  ] as const)("%s refuse un répertoire de travail hors du nôtre", (_type, s, u) => {
    const mauvais: StepContext = { ...ctx(), workDir: "/opt/travail/boutique" }

    expect(() => s(undefined, mauvais)).toThrow(/skynode/)
    expect(() => u(undefined, mauvais)).toThrow(/skynode/)
  })

  it("build.image refuse un nom d'application hors du motif", () => {
    const mauvais: StepContext = { ...ctx(), application: "Boutique; rm -rf /" }

    expect(() => scriptImage(IMAGE, mauvais)).toThrow(/application/)
    expect(() => undoImage(IMAGE, mauvais)).toThrow(/application/)
  })

  /**
   * La dette du jalon 3a, tranchée ici : une recette est appelable directement, sans passer
   * par `parsePlan` ni par `validatePlan`. C'est donc ce point-là qui referme le vocabulaire
   * de `source.type`, et le refermer aussi au validateur ne fermerait rien de neuf.
   */
  it("build.image refuse une source hors du vocabulaire fermé", () => {
    const inconnue = { ...IMAGE, source: { type: "git", path: "." } } as unknown as PlanStep

    expect(() => scriptImage(inconnue)).toThrow(/vocabulaire fermé/)
    expect(() => undoImage(inconnue)).toThrow(/vocabulaire fermé/)
    expect(() => exigeSourceLocale(inconnue as Extract<PlanStep, { type: "build.image" }>)).toThrow(/git/)
  })

  it("accepte la seule source connue", () => {
    expect(() => exigeSourceLocale(IMAGE)).not.toThrow()
  })

  /** Le tableau des recettes est gelé ; les recettes elles-mêmes doivent l'être aussi. */
  it.each(["build.generate_dockerfile", "build.image"] as const)("la recette de %s est gelée", (type) => {
    expect(Object.isFrozen(recipeFor(type))).toBe(true)
  })
})

describe("le harnais de conformité", () => {
  it.each(["build.generate_dockerfile", "build.image"] as const)(
    "le script et l'annulation de %s passent les contrôles",
    (type) => {
      const etape: PlanStep = type === "build.image" ? IMAGE : GENERATE

      expect(() => verifieConformiteScript(type, etape, ctx())).not.toThrow()
    }
  )

  /**
   * Le contrôle « pas de bashisme » ne connaît que ce qu'on lui a appris ; celui-ci vise ce
   * qu'il ne voit pas et que `dash` accepterait en changeant de sens. `scripts/banc.sh check`
   * reste l'autorité.
   */
  it.each([scriptGenerate(), undoGenerate(), scriptImage(), undoImage()])(
    "aucun script ne parle sur la sortie standard hors du protocole",
    (s) => {
      for (const ligne of s.split("\n")) {
        if (/^\s*(printf|echo)\s/.test(ligne)) {
          expect(ligne).toMatch(/emit|>&2|>>?\s/)
        }
      }
    }
  )
})
