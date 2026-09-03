import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { ALLOWED_NETWORK } from "./plan-rules.js"
import type { PlanStep } from "./plan-types.js"
import type { StepContext } from "./step.js"
import { recipeFor } from "./step.js"
import {
  ATTENTE_DEMARRAGE_S,
  CHEMIN_ETAT,
  ETIQUETTE_APP,
  LIGNES_JOURNAL_APP,
  REPERTOIRE_ENV,
  REPERTOIRE_ETAT,
  cheminEnv,
  cheminEtat,
  exigePort,
  exigeReseauAutorise,
  litFichierEnv,
} from "./steps-app.js"
import { LONGUEUR_CONDENSAT } from "./steps-build.js"
import { ETIQUETTE_PORT } from "./steps-proxy.js"

/**
 * La racine des fixtures : `env.write` lit un vrai fichier sur la machine qui compose le
 * script, un chemin inventé ne prouverait rien de ce que fera l'exécuteur.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "next-sans-dockerfile")

/** Les valeurs de l'arborescence d'essai, qui ne doivent apparaître dans aucun message. */
const VALEURS_SECRETES = ["VALEUR_FICTIVE_A", "VALEUR_FICTIVE_B"]

const ctx = (): StepContext => ({
  application: "boutique",
  projectRoot: RACINE,
  workDir: "/opt/skynode/work/boutique",
})

const ETAPE_ENV: PlanStep = { type: "env.write", depuis: ".env.production" }
const ETAPE_RUN: PlanStep = { type: "app.run", port_interne: 3000, reseau: ALLOWED_NETWORK }
const ETAPE_ETAT: PlanStep = { type: "state.record" }

const scriptEnv = (): string => recipeFor("env.write").script(ETAPE_ENV, ctx())
const undoEnv = (): string => recipeFor("env.write").undoScript(ETAPE_ENV, ctx()) ?? ""
const scriptRun = (): string => recipeFor("app.run").script(ETAPE_RUN, ctx())
const undoRun = (): string => recipeFor("app.run").undoScript(ETAPE_RUN, ctx()) ?? ""
const scriptEtat = (): string => recipeFor("state.record").script(ETAPE_ETAT, ctx())
const undoEtat = (): string => recipeFor("state.record").undoScript(ETAPE_ETAT, ctx()) ?? ""

/* ------------------------------------------------------------------------ garde-fous --- */

describe("litFichierEnv", () => {
  it("lit le fichier sous la racine du projet", () => {
    expect(litFichierEnv(RACINE, ".env.production")).toContain("DATABASE_URL")
  })

  it.each(["/etc/passwd", "../secret", "a/../../secret", "sous/../../../etc/shadow"])(
    "refuse un chemin qui sort de la racine : %s",
    (chemin) => {
      expect(() => litFichierEnv(RACINE, chemin)).toThrow()
    }
  )

  /**
   * Ce chemin-ci **reste dans** la racine une fois normalisé : seul le contrôle sur la
   * chaîne le refuse. Sans lui, un `..` traverserait toute la chaîne des contrôles au motif
   * qu'il finit par revenir — et il suffirait alors d'en mettre un de plus.
   */
  it("refuse un segment .. même quand il retombe dans la racine", () => {
    expect(() => litFichierEnv(RACINE, "src/../.env.production")).toThrow()
  })

  /**
   * Celui-ci n'a ni `..` ni `/` en tête : seul le contrôle sur le fichier réel le refuse.
   * Le plan se compose depuis un dépôt que l'agent a lu, et un dépôt hostile peut porter un
   * `.env` qui pointe ailleurs — la clé SSH de qui le déploie, par exemple.
   */
  it("refuse un lien symbolique qui sort de la racine", () => {
    const bac = mkdtempSync(join(tmpdir(), "skynode-env-"))
    const projet = join(bac, "projet")
    const dehors = join(bac, "dehors.env")

    mkdirSync(projet)
    writeFileSync(dehors, "VALEUR_HORS_DEPOT=1\n")
    symlinkSync(dehors, join(projet, "lien.env"))

    expect(() => litFichierEnv(projet, "lien.env")).toThrow(/hors de la racine/)
  })

  /** Un lien qui reste dans la racine est légitime : le contrôle vise la sortie, pas le lien. */
  it("accepte un lien symbolique qui reste dans la racine", () => {
    const bac = mkdtempSync(join(tmpdir(), "skynode-env-"))

    writeFileSync(join(bac, "vrai.env"), "CLE=valeur\n")
    symlinkSync(join(bac, "vrai.env"), join(bac, "lien.env"))

    expect(litFichierEnv(bac, "lien.env")).toContain("CLE=valeur")
  })

  /**
   * Une racine relative rendrait le fichier lu dépendant du répertoire courant du processus :
   * l'agent MCP tourne là où le client l'a lancé, pas dans le dépôt.
   */
  it("refuse une racine de projet relative", () => {
    expect(() => litFichierEnv("relatif/projet", ".env.production")).toThrow(/absolu/)
  })

  /** Le message d'un fichier illisible ne doit rien apprendre de son contenu. */
  it("nomme le fichier manquant sans rien dire de plus", () => {
    expect(() => litFichierEnv(RACINE, ".env.inexistant")).toThrow(/introuvable ou illisible/)
  })
})

describe("exigeReseauAutorise", () => {
  it("accepte le réseau du produit", () => {
    expect(exigeReseauAutorise(ALLOWED_NETWORK)).toBe(ALLOWED_NETWORK)
  })

  /**
   * `host` ferait tomber le conteneur dans la pile réseau de la machine : tous ses ports
   * ouverts d'un coup, sans qu'une ligne du plan rendu à l'humain ne le laisse voir.
   */
  it.each(["host", "bridge", "none", "autre"])("refuse le réseau %s", (reseau) => {
    expect(() => exigeReseauAutorise(reseau)).toThrow(/réseau/)
  })
})

describe("exigePort", () => {
  it.each([1, 3000, 65535])("accepte le port %s", (port) => {
    expect(exigePort(port)).toBe(port)
  })

  it.each([0, -1, 65536, 3000.5, Number.NaN])("refuse le port %s", (port) => {
    expect(() => exigePort(port)).toThrow()
  })
})

describe("les chemins", () => {
  it("nomment le fichier d'après l'application, jamais d'après autre chose", () => {
    expect(cheminEnv("boutique")).toBe(`${REPERTOIRE_ENV}/boutique.env`)
    expect(cheminEtat("boutique")).toBe(`${REPERTOIRE_ETAT}/boutique.json`)
  })

  it.each(["../evasion", "Boutique", "a b", "", "boutique/../autre"])(
    "refusent un nom d'application hostile : %s",
    (nom) => {
      expect(() => cheminEnv(nom)).toThrow()
      expect(() => cheminEtat(nom)).toThrow()
    }
  )
})

/* ------------------------------------------------------------------------- env.write --- */

describe("env.write", () => {
  it("écrit en 0600, possédé par root", () => {
    const s = scriptEnv()

    expect(s).toContain("chmod 0600 '/etc/skynode/env/boutique.env'")
    expect(s).toContain("chown root:root '/etc/skynode/env/boutique.env'")
  })

  /**
   * `/etc/skynode` est en 0700 root : le répertoire des environnements doit l'être aussi,
   * sans quoi le mode du fichier serait la seule barrière et l'umask de la session
   * déciderait de celui du répertoire.
   */
  it("crée son répertoire à son mode, sans s'en remettre à l'umask", () => {
    expect(scriptEnv()).toContain(`install -d -m 0700 -o root -g root '${REPERTOIRE_ENV}'`)
  })

  /**
   * Le contenu vient de la machine du développeur et porte ses secrets. Il entre dans le
   * script par un heredoc quoté et n'en ressort jamais : ni `cat`, ni `printf`, ni message.
   * `runRemote` recopie `step.detail` tel quel dans le rapport rendu à l'agent.
   */
  it("n'imprime jamais le contenu", () => {
    const s = scriptEnv()

    // Le heredoc le porte forcément ; c'est tout ce qui suit qui compte.
    for (const ligne of s.split("\n")) {
      if (VALEURS_SECRETES.some((v) => ligne.includes(v))) {
        expect(ligne).not.toMatch(/^\s*(printf|echo|note|emit|cat\b)/)
      }
    }

    expect(s).not.toMatch(/cat '\/etc\/skynode\/env/)
    expect(s).not.toMatch(/note .*\$\(cat/)
  })

  /** Le compte de lignes suffit à distinguer le bon fichier du mauvais, sans rien révéler. */
  it("ne rend qu'un compte de lignes dans son détail", () => {
    expect(scriptEnv()).toContain("wc -l < '/etc/skynode/env/boutique.env'")
  })

  /**
   * Comparer un brouillon plutôt que le fichier en place : c'est ce qui permet de trancher
   * l'idempotence sans imprimer ni condenser quoi que ce soit du contenu.
   */
  it("tranche l'idempotence par comparaison de fichiers", () => {
    const s = scriptEnv()

    expect(s).toMatch(/cmp -s '\/etc\/skynode\/env\/\.brouillon-boutique' '\/etc\/skynode\/env\/boutique\.env'/)
    expect(s).toContain("fin unchanged")
  })

  /** `mv` sur le même système de fichiers est atomique : jamais de fichier à moitié écrit. */
  it("met le fichier en place d'un seul geste", () => {
    expect(scriptEnv()).toMatch(/mv -f '\/etc\/skynode\/env\/\.brouillon-boutique' '\/etc\/skynode\/env\/boutique\.env'/)
  })

  it("se défait en supprimant le fichier", () => {
    expect(undoEnv()).toContain("rm -f '/etc/skynode/env/boutique.env'")
  })

  /** Un fichier absent n'est pas un échec d'annulation : l'étape n'avait rien posé. */
  it("ne fait pas échouer une annulation sur un fichier absent", () => {
    expect(undoEnv()).toContain("fin unchanged")
  })
})

/* --------------------------------------------------------------------------- app.run --- */

describe("app.run", () => {
  it("démarre sur le réseau interne, sans port publié", () => {
    const s = scriptRun()

    expect(s).toContain(`--network ${ALLOWED_NETWORK}`)
    expect(s).not.toMatch(/-p \d+:/)
    expect(s).not.toMatch(/--publish/)
  })

  it("redémarre automatiquement, sauf arrêt volontaire", () => {
    expect(scriptRun()).toContain("--restart unless-stopped")
  })

  /**
   * `--env-file` refuse un fichier absent, et l'environnement est facultatif dans le plan :
   * les deux branches doivent exister, sinon une application sans `.env` ne démarre jamais.
   */
  it("charge le fichier d'environnement s'il existe, et démarre quand même sinon", () => {
    const s = scriptRun()

    expect(s).toContain("if [ -f '/etc/skynode/env/boutique.env' ]; then")
    expect(s).toContain("demarre --env-file '/etc/skynode/env/boutique.env' \"$image\"")
    expect(s).toContain('demarre "$image"')
  })

  /**
   * L'étiquette du port est posée ici et relue par `proxy.caddy.site` (`steps-proxy.ts`) :
   * sans elle, une image exposant plusieurs ports rend la publication impossible, et
   * l'étape suivante échouerait pour une raison née dans celle-ci.
   */
  it("étiquette le conteneur avec son port interne", () => {
    expect(scriptRun()).toContain(`--label '${ETIQUETTE_PORT}=3000'`)
  })

  /** Invariant n°2 : un conteneur qui n'est pas le nôtre n'est jamais remplacé. */
  it("refuse de toucher un conteneur qui ne porte pas notre étiquette", () => {
    const s = scriptRun()

    expect(s).toContain(`--label '${ETIQUETTE_APP}=boutique'`)
    expect(s).toContain(`proprietaire=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_APP}"}}' boutique`)
    expect(s).toMatch(/if \[ "\$proprietaire" != 'boutique' \]; then\n\s*echec/)
  })

  /**
   * Le remplacement du conteneur ne vient qu'**après** la garde de propriété : l'ordre est
   * la garantie, pas la présence des deux blocs.
   */
  it("ne retire son conteneur qu'après avoir établi qu'il est le sien", () => {
    const s = scriptRun()

    expect(s.indexOf("proprietaire=$(docker inspect")).toBeLessThan(s.indexOf("docker rm -f boutique"))
  })

  /** Rejouée sur le même contenu, la même image et le même port, l'étape ne redémarre rien. */
  it("rend unchanged quand le conteneur tourne déjà tel qu'attendu", () => {
    const s = scriptRun()

    expect(s).toMatch(
      /if \[ "\$courante" = "\$image" \] && \[ "\$marche" = running \] && \[ "\$porte" = '3000' \]; then\n\s*fin unchanged/
    )
    // `.State.Status`, jamais `.State.Running` : mesuré au banc, un conteneur en boucle de
    // redémarrage rend `Running=true`, et l'étape le prendrait pour sain.
    expect(s).toContain("marche=$(docker inspect -f '{{.State.Status}}' boutique")
    expect(s).not.toContain("{{.State.Running}}")
  })

  /**
   * `docker run -d` rend la main sans erreur sur un conteneur qui mourra dans la seconde.
   * Sans cette attente, l'étape annoncerait « démarré » un conteneur déjà mort et c'est
   * `proxy.caddy.site` qui échouerait, en désignant le mauvais coupable.
   */
  it("vérifie que le conteneur tourne encore après démarrage", () => {
    const s = scriptRun()

    expect(s).toContain(`sleep ${ATTENTE_DEMARRAGE_S}`)
    expect(s).toContain(`docker logs --tail ${LIGNES_JOURNAL_APP} boutique`)

    // La garde porte sur `.State.Status` **et** sur `RestartCount`, jamais sur
    // `.State.Running` : un conteneur qui meurt à chaque démarrage sous
    // « --restart unless-stopped » rend Running=true, Status=restarting, ExitCode=1. La
    // garde écrite sur Running laissait donc passer exactement ce qu'elle devait arrêter,
    // et proxy.caddy.site publiait un domaine devant un conteneur qui ne sert rien.
    expect(s).toContain("statut=$(docker inspect -f '{{.State.Status}}' boutique")
    expect(s).toContain("redemarrages=$(docker inspect -f '{{.RestartCount}}' boutique")
    expect(s).toContain('if [ "$statut" != running ] || [ "$redemarrages" != 0 ]; then')
    expect(s).not.toContain("{{.State.Running}}")
    // Un conteneur mort sous le bon nom empêcherait tout rejeu : le nom resterait pris.
    expect(s).toMatch(/docker logs[\s\S]*docker rm -f boutique[\s\S]*echec/)
  })

  /** L'image est celle du contenu transféré, recalculée — jamais celle qu'un champ déclare. */
  it("démarre l'image du contenu transféré, et refuse si elle manque", () => {
    const s = scriptRun()

    expect(s).toContain(`cut -c1-${LONGUEUR_CONDENSAT}`)
    expect(s).toContain(`image='skynode/boutique:'"$sha"`)
    expect(s).toMatch(/if ! docker image inspect "\$image" >\/dev\/null 2>&1; then\n\s*echec/)
  })

  /** Le réseau existant peut porter d'autres applications : on ne le recrée pas, on l'accepte. */
  it("ne crée le réseau que s'il manque", () => {
    expect(scriptRun()).toMatch(
      /if ! docker network inspect skynode >\/dev\/null 2>&1; then\n\s*docker network create skynode/
    )
  })

  it("se défait en arrêtant et retirant le conteneur", () => {
    expect(undoRun()).toContain("docker rm -f boutique")
  })

  /** Une annulation joue après un échec : la garde de propriété y compte davantage encore. */
  it("ne retire à l'annulation qu'un conteneur qui est le nôtre", () => {
    const u = undoRun()

    expect(u).toContain(`{{index .Config.Labels "${ETIQUETTE_APP}"}}`)
    expect(u.indexOf("proprietaire=$(docker inspect")).toBeLessThan(u.indexOf("docker rm -f boutique >&2"))
  })

  /** L'image reste : c'est elle que `rollback` ramène. */
  it("ne retire jamais l'image en défaisant le conteneur", () => {
    expect(undoRun()).not.toMatch(/docker rmi|image prune/)
  })
})

/* ---------------------------------------------------------------------- state.record --- */

describe("state.record", () => {
  it("écrit l'état à l'emplacement que la sonde lit, en 0600 root", () => {
    const s = scriptEtat()

    expect(s).toContain(CHEMIN_ETAT)
    expect(s).toContain(`chmod 0600 '${CHEMIN_ETAT}'`)
    expect(s).toContain(`chown root:root '${CHEMIN_ETAT}'`)
  })

  /**
   * L'état d'une autre application ne doit pas disparaître quand on déploie la nôtre. Un
   * fichier par application ramène la fusion à une concaténation : rien ne relit le JSON,
   * donc rien ne peut le perdre.
   */
  it("assemble l'état depuis un fichier par application", () => {
    const s = scriptEtat()

    expect(s).toContain(`for fichier in ${REPERTOIRE_ETAT}/*.json; do`)
    expect(s).toContain(`> '${REPERTOIRE_ETAT}/boutique.json'`)
    // Aucune analyse de JSON : `jq` n'est pas installé sur une Ubuntu nue, et l'exiger
    // ajouterait une dépendance sur la machine du client pour ce seul usage.
    expect(s).not.toMatch(/\bjq\b|python3?\b/)
  })

  /** Un état qui décrit déjà ce déploiement n'est pas réécrit. */
  it("rend unchanged quand l'état assemblé est identique", () => {
    expect(scriptEtat()).toMatch(/cmp -s '\/etc\/skynode\/\.brouillon-state' '\/etc\/skynode\/state\.json'[\s\S]*fin unchanged/)
  })

  /**
   * Tout ce qui entre dans le JSON est lu **sur la machine**, donc hors du périmètre de
   * `plan-rules.ts` : un guillemet non borné suffirait à sortir de la chaîne JSON.
   */
  it("borne chaque valeur lue sur la machine avant de l'écrire", () => {
    const s = scriptEtat()

    expect(s).toContain("*[!A-Za-z0-9_./:-]*) image='' ;;")
    expect(s).toContain("0*|*[!0-9]*) port='' ;;")
    expect(s).toContain("*[!0-9A-Za-z:.+-]*) demarre_le='' ;;")
    expect(s).toContain("*[!a-z0-9.-]*) domaine='' ;;")
  })

  /** Une valeur inconnue devient `null` : l'état reste du JSON valide et dit qu'il ignore. */
  it("rend null plutôt qu'une chaîne vide", () => {
    expect(scriptEtat()).toContain(`texte() { if [ -z "$1" ]; then printf null; else printf '"%s"' "$1"; fi; }`)
  })

  /** L'état constate ce qui tourne ; il ne recopie pas ce que le plan annonçait. */
  it("refuse d'enregistrer un déploiement dont le conteneur n'existe pas", () => {
    expect(scriptEtat()).toMatch(/if ! docker inspect boutique >\/dev\/null 2>&1; then\n\s*echec/)
  })

  /** Le domaine vient du fichier de site, seule source de vérité du routage. */
  it("lit le domaine sur le fichier de site, pas sur le plan", () => {
    expect(scriptEtat()).toContain("/etc/skynode/caddy/sites/boutique.caddy")
  })

  it("ne porte aucune valeur d'environnement", () => {
    const s = scriptEtat()

    expect(s).not.toContain(REPERTOIRE_ENV)
    expect(s).not.toMatch(/--env-file|env\.production/)
  })

  /** Défaire, c'est retirer notre entrée puis réassembler : l'état ne doit jamais mentir. */
  it("se défait en retirant sa seule entrée puis en réassemblant", () => {
    const u = undoEtat()

    expect(u).toContain(`rm -f '${REPERTOIRE_ETAT}/boutique.json'`)
    expect(u.indexOf(`rm -f '${REPERTOIRE_ETAT}/boutique.json'`)).toBeLessThan(u.indexOf("for fichier in"))
    expect(u).not.toContain(`rm -f '${CHEMIN_ETAT}'`)
  })

  /** Le message d'un rejeu d'annulation ne doit pas parler d'un déploiement qu'on défait. */
  it("dit ce qu'il constate, à l'aller comme au retour", () => {
    // Le message traverse `shellQuote`, qui coupe l'apostrophe : on cherche ce qui la suit.
    expect(scriptEtat()).toContain("tat de la machine décrit déjà ce déploiement")
    expect(undoEtat()).toContain("ne mentionnait déjà plus cette application")
  })
})
