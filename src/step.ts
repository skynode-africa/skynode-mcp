import type { PlanStep, StepType } from "./plan-types.js"

/**
 * Le protocole d'étape : ce qu'une recette doit rendre, et ce que le jalon garantit d'elle
 * avant même qu'elle soit écrite.
 *
 * Le vocabulaire des étapes est fermé (`plan-types.ts`) ; ce module lui associe une recette
 * par type, et `recipeFor` en est la seule source. Un exécuteur ne compose donc jamais de
 * commande : il demande la recette d'un type validé, ou il n'obtient rien. Le tableau et
 * chaque recette sont gelés, pour que cela reste vrai après le premier appel.
 *
 * Les scripts eux-mêmes sont écrits par les tâches 3 à 7. Ici, chaque type a bien sa
 * recette — le tableau est complet dès maintenant — mais celles qui restent à écrire lèvent
 * plutôt que de rendre un script vide : un script vide sortirait sans marqueur de fin,
 * `runRemote` le dirait interrompu, et on lirait une panne de connexion là où il n'y a
 * qu'un morceau non écrit.
 */

export interface StepContext {
  /** Nom de l'application, déjà validé par plan-rules. */
  application: string
  /** Racine du projet local, pour les étapes qui transfèrent. */
  projectRoot: string
  /** Répertoire de travail distant du passage courant. */
  workDir: string
}

export interface StepRecipe {
  /** Le script à exécuter. Idempotent : rejoué, il rend `unchanged`. */
  script(step: PlanStep, ctx: StepContext): string
  /**
   * Le script d'annulation, ou `null` si l'étape n'est pas réversible — installer un
   * paquet ne se désinstalle pas, et prétendre le contraire serait pire que l'admettre.
   */
  undoScript(step: PlanStep, ctx: StepContext): string | null
  /** Certaines étapes ne s'exécutent pas sur la cible SSH ordinaire. Voir la tâche 4. */
  needsSecondSession?: boolean
}

/**
 * Réversibilité déclarée par type, séparée des recettes exprès : l'exécuteur doit pouvoir
 * annoncer ce qu'un retour arrière rendra **avant** d'exécuter quoi que ce soit, y compris
 * pour les recettes non encore écrites. Une réversibilité lue dans la recette obligerait à
 * la construire pour la connaître.
 *
 * `host.prepare` et `host.install_docker` sont irréversibles, et c'est un fait, pas un
 * manque : on ne désinstalle pas Docker, on ne retire pas un pare-feu qu'on vient de poser.
 * L'exécuteur le dira dans son rapport plutôt que de laisser croire à un retour arrière
 * complet.
 */
const REVERSIBILITY: Record<StepType, boolean> = {
  "host.prepare": false,
  "host.install_docker": false,
  "proxy.caddy.install": true,
  "build.generate_dockerfile": true,
  "build.image": true,
  "env.write": true,
  "app.run": true,
  "proxy.caddy.site": true,
  "state.record": true,
}

export function isReversible(step: PlanStep): boolean {
  return REVERSIBILITY[step.type]
}

/** Quelle tâche du jalon écrit quelle recette — pour que le message d'échec l'indique. */
const TACHE_QUI_ECRIT: Record<StepType, string> = {
  "host.prepare": "tâche 3 (et tâche 4 pour le durcissement SSH)",
  "host.install_docker": "tâche 3",
  "proxy.caddy.install": "tâche 5",
  "proxy.caddy.site": "tâche 5",
  "build.generate_dockerfile": "tâche 6",
  "build.image": "tâche 6",
  "env.write": "tâche 7",
  "app.run": "tâche 7",
  "state.record": "tâche 7",
}

/**
 * Une recette dont le script reste à écrire. Elle existe — `recipeFor` la rend, l'exécuteur
 * peut interroger sa réversibilité — mais toute tentative de l'exécuter s'arrête net, en
 * nommant la tâche qui la comblera. Un développeur qui tombe dessus sait quoi ouvrir ; un
 * exécuteur qui tombe dessus ne touche à rien.
 */
function recetteAEcrire(type: StepType): StepRecipe {
  const refus = (): never => {
    throw new Error(
      `La recette de « ${type} » reste à écrire (${TACHE_QUI_ECRIT[type]} du jalon 3b) : aucune exécution possible.`
    )
  }

  return Object.freeze({
    script: refus,
    // Une étape irréversible n'a pas d'annulation à écrire : `null` est déjà sa réponse
    // définitive, et la rendre dès maintenant n'anticipe sur rien. Les autres lèvent, parce
    // qu'y répondre `null` les ferait passer pour irréversibles et contredirait
    // `isReversible` — l'exécuteur promettrait alors un retour arrière qu'il ne ferait pas.
    undoScript: REVERSIBILITY[type] ? refus : () => null,
  })
}

/**
 * Le tableau des recettes, un par type. Les tâches 3 à 7 y remplacent leur entrée par une
 * recette réelle, importée de `steps-host.ts`, `steps-proxy.ts`, `steps-build.ts` ou
 * `steps-app.ts` — ces modules ne dépendent de celui-ci que par des types, donc sans cycle
 * à l'exécution.
 *
 * **Toute recette réelle doit être gelée à sa construction**, comme celles d'ici : un test
 * l'exige pour chaque type inscrit dans `TYPES_IMPLEMENTES`.
 */
const RECIPES: Record<StepType, StepRecipe> = {
  "host.prepare": recetteAEcrire("host.prepare"),
  "host.install_docker": recetteAEcrire("host.install_docker"),
  "proxy.caddy.install": recetteAEcrire("proxy.caddy.install"),
  "build.generate_dockerfile": recetteAEcrire("build.generate_dockerfile"),
  "build.image": recetteAEcrire("build.image"),
  "env.write": recetteAEcrire("env.write"),
  "app.run": recetteAEcrire("app.run"),
  "proxy.caddy.site": recetteAEcrire("proxy.caddy.site"),
  "state.record": recetteAEcrire("state.record"),
}

// `recipeFor` rend l'objet du tableau, pas une copie : sans gel, du code du processus
// pourrait remplacer une recette pour de bon — notamment forcer `undoScript` à rendre
// `null`, ce qui ferait mentir `isReversible` en silence. Un plan ne peut pas l'atteindre,
// il faut du code ici ; mais l'en-tête de ce module promet qu'aucune autre source de
// recette n'existe, et une promesse tenue par convention n'en est pas une.
//
// Ce gel-ci n'est **pas couvert par un test**, et volontairement : `RECIPES` est privé au
// module, donc son remplacement n'est observable de nulle part au dehors. Il ne protège
// que contre une entrée réécrite depuis ce fichier même — ce qu'y feront les tâches 3 à 7.
// Une épreuve par mutation le confirme : le retirer ne tue aucun test. Écrire un test qui
// passerait sans rien éprouver coûterait plus qu'il ne rapporte. Le gel de chaque recette,
// lui, est bien couvert.
Object.freeze(RECIPES)

export function recipeFor(type: PlanStep["type"]): StepRecipe {
  // `Object.hasOwn`, pas `RECIPES[type] === undefined` : un appelant non typé demandant
  // `constructor` ou `toString` récupérerait la propriété héritée d'`Object.prototype` et
  // obtiendrait une « recette » qui est en réalité une fonction du langage.
  if (!Object.hasOwn(RECIPES, type)) {
    throw new Error(
      `Aucune recette pour le type d'étape « ${String(type)} » : le vocabulaire du plan est fermé.`
    )
  }

  return RECIPES[type]
}

/**
 * Les types dont la recette est écrite et doit donc passer le harnais de conformité
 * ci-dessous.
 *
 * **Contrat entre tâches : vide en tâche 2, chaque tâche suivante y ajoute le ou les types
 * qu'elle vient d'écrire.** C'est la seule ligne à modifier pour qu'une recette neuve soit
 * soumise aux quatre contrôles — les oublier reviendrait à écrire un script d'écriture en
 * root que rien ne relit.
 */
export const TYPES_IMPLEMENTES: readonly PlanStep["type"][] = []

/**
 * Ce que `dash` — le `/bin/sh` de Debian et d'Ubuntu — refuse ou, pire, accepte en lui
 * donnant un autre sens. Les deux dernières entrées sont les plus dangereuses : elles ne
 * lèvent rien, même sous `set -e`. `cmd &> /dev/null` y est lu comme `cmd &` suivi de
 * `> /dev/null`, donc la commande part en arrière-plan et l'étape rend `applied` avant que
 * quoi que ce soit ait abouti ; `echo -e "a\tb"` imprime le `-e` au lieu de l'interpréter.
 */
const BASHISMES: ReadonlyArray<{ motif: RegExp; quoi: string }> = [
  { motif: /\[\[/, quoi: "`[[`" },
  // Une affectation de tableau. Ancrée à un début de mot pour ne pas confondre avec la
  // substitution `$(…)` ni avec un `=(` apparaissant dans une chaîne quotée.
  { motif: /(^|[;&|(\s])[A-Za-z_][A-Za-z0-9_]*=\(/m, quoi: "une affectation de tableau `nom=(…)`" },
  { motif: /(^|[;&|{\s])function\s+[A-Za-z_][A-Za-z0-9_]*\s*(\(\s*\))?\s*\{/m, quoi: "`function nom()`" },
  { motif: /[<>]\(/, quoi: "une substitution de processus `<(…)`" },
  // `source` comme commande, jamais comme fragment de chemin : `/usr/src/source.tar` ne
  // doit pas déclencher, `. fichier` est la forme POSIX à employer.
  { motif: /(^[ \t]*|[;&|{][ \t]*|\s&&\s|\s\|\|\s)source\s+\S/m, quoi: "`source` (utiliser `.`)" },
  // `&>` et `&>>`. La forme POSIX est `> fichier 2>&1`. On exclut `&&`, et `2>&1` ne
  // correspond pas puisqu'il n'y a pas de `&` avant le `>`.
  { motif: /(^|[^&>])&>/m, quoi: "`&>` (utiliser `> fichier 2>&1`)" },
  // `echo -e` en tête de commande. Un argument qui commence par `-e` sans être le premier
  // n'est pas concerné, et `echo "-e ..."` non plus.
  { motif: /(^|[;&|{]\s*|\s&&\s|\s\|\|\s|\|\s*)echo\s+-e\b/m, quoi: "`echo -e` (utiliser `printf`)" },
]

/** Chaque contrôle du harnais, avec ce qu'il empêche, pour que l'échec se lise seul. */
const CONTROLES: ReadonlyArray<{
  nom: string
  verifie: (script: string) => boolean
  pourquoi: string
  /** Faux pour les contrôles qui n'ont pas de sens sur un script d'annulation. */
  surUndo: boolean
}> = [
  {
    nom: "marqueur de fin",
    verifie: (s) => s.includes("step.end"),
    pourquoi:
      "sans lui, `runRemote` juge la sortie tronquée et rend `failed` sur une étape pourtant jouée jusqu'au bout",
    surUndo: true,
  },
  {
    nom: "pas de bashisme",
    // `/bin/sh` est `dash` sur Debian et Ubuntu : ces formes échouent — ou changent de
    // sens — sur le serveur du client, et jamais ici. Ce motif ne connaît que ce qu'on lui
    // a appris ; `scripts/banc.sh check` soumet le script au vrai `dash`, et c'est lui qui
    // fait autorité.
    verifie: (s) => !BASHISMES.some(({ motif }) => motif.test(s)),
    pourquoi: "ces formes n'ont pas le même sens dans le `sh` du serveur, quand elles y sont valides",
    surUndo: true,
  },
  {
    nom: "pas de `local`",
    // Une vraie RegExp, pas un motif reconstruit depuis un gabarit : dans un littéral de
    // gabarit JS, `\s` se réduit à un `s` littéral et le contrôle ne chercherait plus rien.
    // Désancré du début de ligne, sinon `f() { local x=1; }` passe.
    verifie: (s) => !/(^[ \t]*|[;&|{][ \t]*)local\s/m.test(s),
    pourquoi: "`local` n'est pas POSIX — accepté par `dash` mais pas par tous les `sh`",
    surUndo: true,
  },
  {
    nom: "garde d'idempotence",
    verifie: (s) => s.includes("unchanged"),
    pourquoi: "une étape rejouée doit pouvoir dire qu'elle n'a rien changé (invariant n°3)",
    // Une annulation n'a pas ce contrat : elle défait, elle ne se rejoue pas pour constater.
    surUndo: false,
  },
]

/**
 * Le harnais que toute recette écrite doit franchir, partagé par les suites de tâches
 * ultérieures plutôt que recopié dans chacune : recopié, il dériverait, et c'est justement
 * la divergence entre deux copies d'une même règle qui a coûté le plus cher au jalon
 * précédent (`plan-rules.ts`).
 *
 * Il lève au lieu d'utiliser les assertions du testeur, pour ne rien devoir à `vitest` : ce
 * module est du code de production, importé par l'exécuteur.
 */
export function verifieConformiteScript(
  type: PlanStep["type"],
  etape: PlanStep,
  ctx: StepContext,
  /**
   * La recette à éprouver, par défaut celle du type. Injectable pour que le branchement de
   * ce harnais — et non les seuls contrôles — soit couvert avant qu'une recette réelle
   * existe : le tableau est gelé, on ne peut plus y substituer une recette d'essai.
   */
  recette: StepRecipe = recipeFor(type)
): void {
  verifieUnScript(type, "script", recette.script(etape, ctx), true)

  // Le script d'annulation subit les mêmes contrôles, la garde d'idempotence exceptée. Il
  // ne s'emprunte qu'après l'échec d'une étape : c'est le chemin le moins parcouru, et
  // celui dont la défaillance produit le serveur laissé à mi-chemin que l'invariant n°4
  // désigne comme le pire résultat possible.
  const undo = recette.undoScript(etape, ctx)
  if (undo !== null) verifieUnScript(type, "script d'annulation", undo, false)
}

/**
 * Les mêmes contrôles, sur un script fourni directement plutôt que produit par une recette.
 *
 * Exporté pour que les suites de tests éprouvent les contrôles eux-mêmes — un contrôle qui
 * laisse tout passer est pire qu'aucun contrôle — **sans avoir à remplacer la recette d'un
 * type dans le tableau**. Ce tableau est gelé, et l'idiome de la mutation, recopié par les
 * tâches 3 à 7, aurait fini par masquer un défaut réel.
 *
 * `estPrincipal` à `false` lève la garde d'idempotence, qui ne s'applique pas à une
 * annulation.
 */
export function verifieUnScript(
  type: PlanStep["type"],
  quel: string,
  script: string,
  estPrincipal: boolean
): void {
  for (const controle of CONTROLES) {
    if (!estPrincipal && !controle.surUndo) continue

    if (!controle.verifie(script)) {
      throw new Error(
        `Le ${quel} de « ${type} » ne respecte pas le contrôle « ${controle.nom} » : ${controle.pourquoi}.`
      )
    }
  }
}
