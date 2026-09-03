import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import type { PlanStep } from "./plan-types.js"
import type { StepContext } from "./step.js"
import type { StepRecipe } from "./step.js"
import {
  TYPES_IMPLEMENTES,
  isReversible,
  recipeFor,
  verifieConformiteScript,
  verifieUnScript,
} from "./step.js"

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

/**
 * Une racine de projet **qui existe vraiment**, et non un chemin inventé : `env.write` lit le
 * fichier d'environnement sur la machine du développeur au moment où son script se compose
 * (`steps-app.ts`), et une racine fictive ferait échouer le harnais de conformité pour une
 * raison qui n'a rien à voir avec la conformité.
 */
const RACINE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "next-sans-dockerfile")

const contexte = (): StepContext => ({
  application: "boutique",
  projectRoot: RACINE_FIXTURE,
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
    ["sans garde d'idempotence", "printf 'step.outcome\\tapplied\\nstep.end\\t1\\n'"],
  ]

  it.each(fautifs)("le harnais refuse un script %s", (_nom, script) => {
    expect(() => verifieUnScript("state.record", "script", script, true)).toThrow(/contrôle/)
  })

  it("le harnais accepte un script conforme", () => {
    const script = ["printf 'step.outcome\\t%s\\n' unchanged", "printf 'step.end\\t1\\n'"].join("\n")

    expect(() => verifieUnScript("state.record", "script", script, true)).not.toThrow()
  })

  /**
   * Les formes que `dash` — le `/bin/sh` de Debian et d'Ubuntu — refuse, ou pire, accepte en
   * leur donnant un autre sens.
   *
   * Les quatre dernières sont les plus dangereuses et justifient à elles seules ce contrôle :
   * mesuré sous le `dash` d'Ubuntu 24.04, `sleep 2 &> /dev/null` rend **en zéro seconde** —
   * la commande est partie en arrière-plan — sans que `set -e` bronche, et
   * `echo -e "a\tb"` imprime `-e` au lieu de l'interpréter. Un `docker build … &> /dev/null`
   * rendrait donc `applied` sans qu'aucune image existe.
   */
  const bashismes: ReadonlyArray<readonly [string, string]> = [
    ["[[", "if [[ -d /srv ]]; then :; fi"],
    ["une affectation de tableau", "arr=(a b c)"],
    ["une affectation de tableau indentée", "  arr=(a b c)"],
    ["une affectation de tableau après ;", "x=1; arr=(a b)"],
    ["function nom()", "function f() { echo a; }"],
    ["function sans parenthèses", "function f { echo a; }"],
    ["une substitution de processus", "diff <(ls) <(ls)"],
    ["source", "source /etc/profile"],
    ["source indenté", "  source /etc/profile"],
    ["source après &&", "true && source /etc/profile"],
    ["local sur une ligne", "f() { local x=1; }"],
    ["local après ;", "f() { :; local x=1; }"],
    ["local indenté", "  local x=1"],
    ["&>", "docker build . &> /dev/null"],
    ["&>>", "docker build . &>> /tmp/journal"],
    ["echo -e", 'echo -e "a\\tb"'],
    ["echo -e après |", "ls | echo -e x"],
  ]

  it.each(bashismes)("le harnais refuse %s", (_nom, fragment) => {
    const script = `${fragment}\nprintf 'unchanged step.end\\n'`

    expect(() => verifieUnScript("state.record", "script", script, true)).toThrow(/contrôle/)
  })

  /**
   * L'autre sens, sans quoi un contrôle trop large ferait rejeter des scripts corrects — et
   * la tâche qui s'y heurterait le contournerait plutôt que de le comprendre. Ces seize
   * formes ont toutes été passées au `dash` réel d'Ubuntu 24.04 : aucune n'y est fautive.
   */
  const conformes: ReadonlyArray<readonly [string, string]> = [
    ["le test POSIX", "[ -f x ] && echo a"],
    ["un chemin contenant « source »", "tar -xf /usr/src/source.tar"],
    ["« source » en argument", "echo /usr/src/source.tar"],
    ["un mot finissant par « source »", "resource=1"],
    ["« -e » dans une chaîne", 'echo "-e reste littéral"'],
    ["« -e » en second argument", "echo x -e"],
    ["printf", "printf 'a\\tb\\n'"],
    ["la redirection POSIX", "docker build . > /dev/null 2>&1"],
    ["&& , qui n'est pas &>", "true && false"],
    ["le point, forme POSIX de source", ". /etc/profile"],
    ["une substitution de commande", "x=$(ls)"],
    ["une affectation simple", "x=1"],
    ["case et sa parenthèse fermante", "case $x in a) echo a;; esac"],
    ["un mot commençant par « local »", "localiser() { echo a; }"],
    ["« local » en préfixe de mot", "echo localhost"],
    ["un script ordinaire", "if [ 1 -gt 0 ]; then :; fi"],
  ]

  it.each(conformes)("le harnais accepte %s", (_nom, fragment) => {
    const script = `${fragment}\nprintf 'unchanged step.end\\n'`

    expect(() => verifieUnScript("state.record", "script", script, true)).not.toThrow()
  })

  /**
   * Le corps d'un heredoc est une **donnée** — le contenu d'un fichier qu'on écrit — et
   * n'est jamais exécuté comme du shell. Y chercher des bashismes refusait du travail
   * légitime, et façonnait déjà le code de production : la règle sudoers de `host.prepare`
   * a été écrite sans spécification d'exécutant en partie pour contourner `ALL=(`.
   *
   * Les tâches qui écrivent un Caddyfile, un `.env` ou un fichier de composition ne
   * peuvent pas altérer ce qu'un client y met. Un garde-fou qui refuse leur travail
   * finirait contourné, ce qui est pire que pas de garde-fou.
   */
  describe("le corps des heredocs", () => {
    const ecrire = (contenu: string): string =>
      `cat > /etc/skynode/x <<'FIN'\n${contenu}\nFIN\nprintf 'unchanged step.end\\n'`

    it.each([
      ["une variable valant `(a b)`", "OPTIONS=(a b)"],
      ["une redirection `&>` dans un Caddyfile", "log { output file /var/log/a.log &> stderr }"],
      ["un `source` dans un script du client", "source /opt/env.sh"],
      ["une documentation citant `[[`", "# comparer avec [[ -f x ]]"],
      ["un `local` dans une fonction du client", "f() { local x=1; }"],
      ["un `function nom()`", "function demarrer() { :; }"],
      ["une substitution de processus", "diff <(a) <(b)"],
    ])("laisse passer %s", (_nom, contenu) => {
      expect(() => verifieUnScript("env.write", "script", ecrire(contenu), true)).not.toThrow()
    })

    it.each([
      ["avant tout heredoc", "docker build . &> /dev/null\ncat > a <<FIN\nx\nFIN"],
      ["après un heredoc fermé", "cat > a <<FIN\nx\nFIN\ndocker build . &> /dev/null"],
      ["sur la ligne d'ouverture elle-même", "cat > a <<FIN &> /dev/null\nx\nFIN"],
    ])("refuse toujours un bashisme %s", (_nom, corps) => {
      const script = `${corps}\nprintf 'unchanged step.end\\n'`

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/bashisme/)
    })

    /**
     * Sans cela, tout ce qui suit l'ouverture serait avalé et un bashisme réel passerait.
     * Et c'est de toute façon un script cassé : `sh` lirait jusqu'à la fin du fichier.
     */
    it("refuse un heredoc jamais refermé", () => {
      const script = "cat > a <<FIN\ndonnee\ndocker build . &> /dev/null\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/referme jamais/)
    })

    /**
     * `<<<` n'est **pas** cherché par le motif, et c'est délibéré : un délimiteur de bloc
     * marqué s'écrit `# <<< skynode-… <<<`, cité en argument de `grep`. Le refuser ici
     * ferait rejeter les scripts de SkyNode eux-mêmes — constaté sur `host.prepare` avec
     * fichier d'échange. `dash -n` fait la distinction, pas une expression régulière.
     */
    it("laisse passer un délimiteur de bloc marqué", () => {
      const script =
        "grep -c -F -x -- '# <<< skynode-swap <<<' /etc/fstab\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).not.toThrow()
    })

    /**
     * `<<` ne compte que hors guillemets. L'analyseur ouvrait un heredoc sur n'importe quel
     * `<<MOT` de la ligne : la levée sur heredoc non refermé rattrapait la plupart des
     * accidents, mais pas celui où le faux délimiteur coïncide avec un mot figurant seul
     * plus loin — or `fi`, `done`, `esac` et `else` sont exactement de ces mots. Mesuré :
     * le script ci-dessous était **accepté**, tout son corps sauté, `[[` et `rm -rf /`
     * compris.
     */
    it.each([
      ["fi", "echec 'la valeur << fi est atteinte'\n[[ -f /x ]]\nrm -rf /\nfi"],
      ["done", 'note "compte << done atteint"\n[[ -f /x ]]\ndone'],
      ["esac", "note 'motif << esac'\ndocker build . &> /dev/null\nesac"],
      ["else", "note 'sinon << else'\nsource /etc/profile\nelse"],
    ])("un `<<` cité ne peut pas ouvrir un faux heredoc jusqu'à `%s`", (_mot, corps) => {
      const script = `${corps}\nprintf 'unchanged step.end\\n'`

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/contrôle/)
    })

    /**
     * Le même défaut jouait dans l'autre sens, et c'est celui qui finit par faire
     * contourner le garde-fou : un `<<FIN` cité dans un commentaire ouvrait un heredoc que
     * rien ne fermait, et le harnais refusait un script parfaitement correct.
     */
    it("un `<<` en commentaire n'ouvre rien", () => {
      const script = "# on écrirait ici avec cat <<FIN\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).not.toThrow()
    })

    it("un `<<` en commentaire ne masque pas le bashisme qui suit", () => {
      const script = "# on écrirait ici avec cat <<FIN\ndocker build . &> /dev/null\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/bashisme/)
    })

    /** Un `#` au milieu d'un mot n'est pas un commentaire : `x=a#b` est une affectation. */
    it("ne prend pas un `#` collé à un mot pour un commentaire", () => {
      const script = "x=a#b\ndocker build . &> /dev/null\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/bashisme/)
    })

    /**
     * Un guillemet simple protège tout ce qu'il enferme, double guillemet compris : c'est
     * ce qui rend inoffensif l'`awk -F: '$1=="fpr" …'` de `host.install_docker`.
     */
    it("ne se laisse pas dérouter par un double guillemet cité", () => {
      const script =
        "empreinte=$(gpg --with-colons k | awk -F: '$1==\"fpr\" {print $10; exit}')\n" +
        "docker build . &> /dev/null\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/bashisme/)
    })

    /**
     * `<<<` doit ressortir intact : c'est un bashisme, et le laisser passer l'envoie à
     * `dash -n`, qui le refuse pour de bon. Le prendre pour une ouverture ferait sauter
     * tout ce qui suit — ici le `&>` de la ligne d'après.
     */
    it("ne prend pas `<<<` pour une ouverture de heredoc", () => {
      const script = "grep x <<<FIN\ndocker build . &> /dev/null\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/bashisme/)
    })

    /** `$((1 << 2))` est un décalage arithmétique, pas une ouverture de heredoc. */
    it("ne prend pas un décalage arithmétique pour un heredoc", () => {
      const script = "n=$((1 << 2))\ndocker build . &> /dev/null\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", script, true)).toThrow(/bashisme/)
    })

    it("suit deux heredocs successifs et un heredoc indenté", () => {
      const deux = "cat > a <<A\nx=(1)\nA\ncat > b <<B\ny=(2)\nB\nprintf 'unchanged step.end\\n'"
      const indente = "cat > a <<-FIN\n\tx=(1)\n\tFIN\nprintf 'unchanged step.end\\n'"

      expect(() => verifieUnScript("env.write", "script", deux, true)).not.toThrow()
      expect(() => verifieUnScript("env.write", "script", indente, true)).not.toThrow()
    })
  })

  /**
   * Le script d'annulation ne s'emprunte qu'après l'échec d'une étape : c'est le chemin le
   * moins parcouru, et celui dont la défaillance produit le serveur laissé à mi-chemin que
   * l'invariant n°4 désigne comme le pire résultat possible. Il subit donc les mêmes
   * contrôles — la garde d'idempotence exceptée, qui n'a pas de sens pour une annulation.
   */
  describe("le script d'annulation", () => {
    it("subit le contrôle des bashismes", () => {
      expect(() =>
        verifieUnScript("state.record", "script d'annulation", "cmd &> /dev/null\nstep.end", false)
      ).toThrow(/bashisme/)
    })

    it("subit le contrôle du marqueur de fin", () => {
      expect(() => verifieUnScript("state.record", "script d'annulation", "rm -f /x", false)).toThrow(
        /marqueur de fin/
      )
    })

    it("est dispensé de la garde d'idempotence", () => {
      expect(() =>
        verifieUnScript("state.record", "script d'annulation", "rm -f /x\nstep.end", false)
      ).not.toThrow()
    })

    it("nomme lequel des deux scripts est fautif", () => {
      expect(() =>
        verifieUnScript("state.record", "script d'annulation", "rm -f /x", false)
      ).toThrow(/script d'annulation/)
    })

    /**
     * Le branchement, et non les seuls contrôles : une épreuve par mutation a montré que
     * retirer l'appel à `undoScript` dans `verifieConformiteScript` ne tuait aucun test,
     * puisque tous s'adressaient à `verifieUnScript` en direct. C'est pourtant le
     * branchement qui fait le correctif.
     */
    it("est bien relu par le harnais complet", () => {
      const conforme = "printf 'unchanged step.end\\n'"
      const recette: StepRecipe = {
        script: () => conforme,
        undoScript: () => "cmd &> /dev/null\nstep.end",
      }

      expect(() =>
        verifieConformiteScript("state.record", etapeDe("state.record"), contexte(), recette)
      ).toThrow(/script d'annulation/)
    })

    it("n'est pas exigé quand la recette rend `null`", () => {
      const recette: StepRecipe = {
        script: () => "printf 'unchanged step.end\\n'",
        undoScript: () => null,
      }

      expect(() =>
        verifieConformiteScript("state.record", etapeDe("state.record"), contexte(), recette)
      ).not.toThrow()
    })
  })

  /**
   * Le tableau des recettes est la seule source de scripts du produit. S'il restait
   * modifiable, du code du processus pourrait forcer `undoScript` à rendre `null` :
   * `isReversible` continuerait de promettre un retour arrière que l'exécuteur ne ferait
   * plus. Un plan ne peut pas l'atteindre — il faut du code ici —, mais l'en-tête du module
   * l'affirme, et une promesse tenue par convention n'en est pas une.
   */
  describe("les recettes sont gelées", () => {
    it.each(TOUS_LES_TYPES)("%s est gelée", (type) => {
      expect(Object.isFrozen(recipeFor(type))).toBe(true)
    })

    it("une réécriture de script ne prend pas", () => {
      const avant = recipeFor("state.record").script

      try {
        // @ts-expect-error — on éprouve ce qu'un appelant non typé pourrait tenter.
        recipeFor("state.record").script = () => "détourné"
      } catch {
        // En mode strict, l'affectation lève ; hors mode strict elle est ignorée. Les deux
        // conviennent, seul le résultat compte.
      }

      expect(recipeFor("state.record").script).toBe(avant)
    })
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
