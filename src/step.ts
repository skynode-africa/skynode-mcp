import type { PlanStep, StepType } from "./plan-types.js"

/**
 * Le protocole d'étape : ce qu'une recette doit rendre, et ce que le jalon garantit d'elle
 * avant même qu'elle soit écrite.
 *
 * Le vocabulaire des étapes est fermé (`plan-types.ts`) ; ce module lui associe une recette
 * par type, et rien d'autre ne peut en produire une. Un exécuteur ne compose donc jamais de
 * commande : il demande la recette d'un type validé, ou il n'obtient rien.
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

  return {
    script: refus,
    // Une étape irréversible n'a pas d'annulation à écrire : `null` est déjà sa réponse
    // définitive, et la rendre dès maintenant n'anticipe sur rien. Les autres lèvent, parce
    // qu'y répondre `null` les ferait passer pour irréversibles et contredirait
    // `isReversible` — l'exécuteur promettrait alors un retour arrière qu'il ne ferait pas.
    undoScript: REVERSIBILITY[type] ? refus : () => null,
  }
}

/**
 * Le tableau des recettes, un par type. Les tâches 3 à 7 y remplacent leur entrée par une
 * recette réelle, importée de `steps-host.ts`, `steps-proxy.ts`, `steps-build.ts` ou
 * `steps-app.ts` — ces modules ne dépendent de celui-ci que par des types, donc sans cycle
 * à l'exécution.
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

/** Chaque contrôle du harnais, avec ce qu'il empêche, pour que l'échec se lise seul. */
const CONTROLES: ReadonlyArray<{ nom: string; verifie: (script: string) => boolean; pourquoi: string }> = [
  {
    nom: "marqueur de fin",
    verifie: (s) => s.includes("step.end"),
    pourquoi:
      "sans lui, `runRemote` juge la sortie tronquée et rend `failed` sur une étape pourtant jouée jusqu'au bout",
  },
  {
    nom: "pas de bashisme",
    // `/bin/sh` est `dash` sur Debian et Ubuntu : `[[` y est une erreur de syntaxe, sur le
    // serveur du client et jamais ici.
    verifie: (s) => !/\[\[/.test(s),
    pourquoi: "`[[` n'existe pas dans le `sh` du serveur",
  },
  {
    nom: "pas de `local`",
    // Une vraie RegExp, pas un motif reconstruit depuis un gabarit : dans un littéral de
    // gabarit JS, `\s` se réduit à un `s` littéral et le contrôle ne chercherait plus rien.
    verifie: (s) => !/^\s*local\s/m.test(s),
    pourquoi: "`local` n'est pas POSIX — accepté par `dash` mais pas par tous les `sh`",
  },
  {
    nom: "garde d'idempotence",
    verifie: (s) => s.includes("unchanged"),
    pourquoi: "une étape rejouée doit pouvoir dire qu'elle n'a rien changé (invariant n°3)",
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
  ctx: StepContext
): void {
  const script = recipeFor(type).script(etape, ctx)

  for (const controle of CONTROLES) {
    if (!controle.verifie(script)) {
      throw new Error(
        `Le script de « ${type} » ne respecte pas le contrôle « ${controle.nom} » : ${controle.pourquoi}.`
      )
    }
  }
}
