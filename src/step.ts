import type { PlanStep, StepType } from "./plan-types.js"
import { RECETTE_APP_RUN, RECETTE_ENV_WRITE, RECETTE_STATE_RECORD } from "./steps-app.js"
import { RECETTE_BUILD_GENERATE_DOCKERFILE, RECETTE_BUILD_IMAGE } from "./steps-build.js"
import { RECETTE_HOST_INSTALL_DOCKER, RECETTE_HOST_PREPARE } from "./steps-host.js"
import { RECETTE_PROXY_CADDY_INSTALL, RECETTE_PROXY_CADDY_SITE } from "./steps-proxy.js"

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
  "host.prepare": RECETTE_HOST_PREPARE,
  "host.install_docker": RECETTE_HOST_INSTALL_DOCKER,
  "proxy.caddy.install": RECETTE_PROXY_CADDY_INSTALL,
  "build.generate_dockerfile": RECETTE_BUILD_GENERATE_DOCKERFILE,
  "build.image": RECETTE_BUILD_IMAGE,
  "env.write": RECETTE_ENV_WRITE,
  "app.run": RECETTE_APP_RUN,
  "proxy.caddy.site": RECETTE_PROXY_CADDY_SITE,
  "state.record": RECETTE_STATE_RECORD,
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
export const TYPES_IMPLEMENTES: readonly PlanStep["type"][] = [
  "host.prepare",
  "host.install_docker",
  "proxy.caddy.install",
  "proxy.caddy.site",
  "build.generate_dockerfile",
  "build.image",
  "env.write",
  "app.run",
  "state.record",
]

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
  // Pas de motif pour la chaîne en entrée `<<<` : un délimiteur de bloc marqué s'écrit
  // `# <<< skynode-… <<<`, et aucune expression régulière ne distingue ces octets, cités
  // en argument de `grep`, d'une vraie redirection. `dash -n` le fait — il refuse `<<<`
  // comme erreur de syntaxe et l'ignore entre guillemets — et `scripts/banc.sh check` le
  // soumet à chaque script. C'est le partage voulu : le motif garde les formes que `dash`
  // accepte en leur donnant un autre sens, `dash` garde celles qu'il refuse.
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
/** Ce qui, hors guillemets, ouvre un mot — et donc le seul endroit où `#` fait commentaire. */
function separeLesMots(c: string): boolean {
  return c === " " || c === "\t" || c === ";" || c === "&" || c === "|" || c === "("
}

/**
 * Le délimiteur du heredoc que cette ligne ouvre, ou `null`.
 *
 * `<<` ne compte que **hors guillemets et hors commentaire**. Un suivi de citation en une
 * passe suffit, et il est nécessaire : reconnaître un `<<` où qu'il tombe faisait sauter le
 * corps d'un heredoc qui n'existe pas, jusqu'à un mot isolé qui ressemble au faux
 * délimiteur. Or `fi`, `done`, `esac` et `else` sont exactement de ces mots — le faux corps
 * avalé est alors du vrai shell. Mesuré : `echec 'la valeur << fi est atteinte'` suivi de
 * `[[ -f /x ]]`, `rm -rf /` puis `fi` passait le harnais entier.
 *
 * Le même défaut jouait dans l'autre sens : un `<<FIN` cité dans un commentaire ouvrait un
 * heredoc que rien ne fermait, et le harnais refusait un script correct — un garde-fou qui
 * refuse du travail légitime finit contourné.
 *
 * `<<<` reste ignoré ici, délibérément : c'est un bashisme, et le laisser passer l'envoie à
 * `dash -n`, qui le refuse pour de bon (`scripts/banc.sh check`). Une expression régulière
 * ne saurait pas le distinguer d'un délimiteur de bloc marqué `# <<< skynode-… <<<`.
 */
function ouvertureHeredoc(ligne: string): string | null {
  let i = 0
  let debutDeMot = true

  while (i < ligne.length) {
    // `noUncheckedIndexedAccess` : l'indice est borné par la boucle, mais le dire au
    // compilateur vaut mieux qu'une assertion qui mentirait le jour où la borne changerait.
    const c = ligne[i]
    if (c === undefined) break

    // Une contre-oblique retire son sens au caractère suivant, quel qu'il soit.
    if (c === "\\") {
      i += 2
      debutDeMot = false
      continue
    }

    // Un guillemet simple protège tout ce qu'il enferme, y compris le double guillemet :
    // c'est ce qui rend `awk -F: '$1=="fpr" …'` inoffensif pour ce suivi.
    if (c === "'") {
      const fin = ligne.indexOf("'", i + 1)
      // Une citation qui ne se referme pas sur la ligne : on ne sait plus rien de la suite,
      // et prétendre y lire une ouverture serait précisément l'erreur qu'on corrige.
      if (fin === -1) return null
      i = fin + 1
      debutDeMot = false
      continue
    }

    if (c === '"') {
      i += 1
      while (i < ligne.length && ligne[i] !== '"') i += ligne[i] === "\\" ? 2 : 1
      if (i >= ligne.length) return null
      i += 1
      debutDeMot = false
      continue
    }

    // Plus rien d'exécutable après : le reste de la ligne est un commentaire.
    if (c === "#" && debutDeMot) return null

    if (c === "<" && ligne[i + 1] === "<") {
      const trouve = delimiteurApres(ligne, i + 2)
      if (trouve !== null) return trouve
      // Pas de délimiteur reconnaissable : un décalage arithmétique `$((1 << 2))`, ou un
      // `<<<`, dont le troisième `<` n'est pas un début de délimiteur valide. Ce dernier
      // ressort donc intact et atteint `dash -n`, seul juge capable de le distinguer d'un
      // délimiteur de bloc marqué `# <<< skynode-… <<<` cité en argument de `grep`. La
      // ligne peut encore ouvrir un vrai heredoc plus loin.
      i += 2
      debutDeMot = false
      continue
    }

    debutDeMot = separeLesMots(c)
    i += 1
  }

  return null
}

/** Le délimiteur qui suit un `<<` déjà reconnu : `<<-` toléré, délimiteur quoté ou nu. */
function delimiteurApres(ligne: string, depart: number): string | null {
  let j = depart
  if (ligne[j] === "-") j += 1
  while (ligne[j] === " " || ligne[j] === "\t") j += 1

  const forme = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(ligne.slice(j))
  if (forme === null) return null

  return forme[1] ?? forme[2] ?? forme[3] ?? null
}

/**
 * Le script débarrassé du corps de ses heredocs.
 *
 * Un corps de heredoc est une **donnée** — le contenu d'un fichier qu'on écrit — et n'est
 * jamais exécuté comme du shell. Y chercher des bashismes refuse du travail parfaitement
 * légitime : mesuré, une variable d'environnement valant `X=(a b)`, un Caddyfile portant
 * `&>`, un script du client contenant `source`, une documentation citant `[[`. Les tâches
 * qui écrivent un Caddyfile, un `.env` ou un fichier de composition heurteraient donc le
 * garde-fou sur des contenus qu'elles n'ont pas le droit d'altérer — et un garde-fou qui
 * refuse du travail légitime finit contourné, ce qui est pire que pas de garde-fou.
 *
 * La ligne d'ouverture reste examinée : `cat > x <<'FIN'` est du shell, et une redirection
 * fautive s'y verrait.
 */
function sansCorpsDeHeredoc(script: string): string {
  const lignes = script.split("\n")
  const gardees: string[] = []
  let delimiteur: string | null = null

  for (const ligne of lignes) {
    if (delimiteur !== null) {
      // Un délimiteur peut être indenté quand le heredoc s'ouvre par `<<-`.
      if (ligne.trim() === delimiteur) delimiteur = null
      continue
    }

    gardees.push(ligne)
    delimiteur = ouvertureHeredoc(ligne)
  }

  if (delimiteur !== null) {
    // Un heredoc jamais fermé avalerait tout ce qui suit, y compris un bashisme réel. Et
    // c'est de toute façon un script cassé : `sh` lirait jusqu'à la fin sans jamais
    // exécuter la suite. Le signaler ici plutôt que de rendre un script tronqué.
    throw new Error(
      `Le script ouvre un heredoc « ${delimiteur} » qu'il ne referme jamais : tout ce qui suit ` +
        "serait avalé au lieu d'être exécuté."
    )
  }

  return gardees.join("\n")
}

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
    verifie: (s) => !BASHISMES.some(({ motif }) => motif.test(sansCorpsDeHeredoc(s))),
    pourquoi: "ces formes n'ont pas le même sens dans le `sh` du serveur, quand elles y sont valides",
    surUndo: true,
  },
  {
    nom: "pas de `local`",
    // Une vraie RegExp, pas un motif reconstruit depuis un gabarit : dans un littéral de
    // gabarit JS, `\s` se réduit à un `s` littéral et le contrôle ne chercherait plus rien.
    // Désancré du début de ligne, sinon `f() { local x=1; }` passe.
    verifie: (s) => !/(^[ \t]*|[;&|{][ \t]*)local\s/m.test(sansCorpsDeHeredoc(s)),
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
