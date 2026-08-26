import type { PlanStep } from "./plan-types.js"

/**
 * Règles partagées entre le composeur (`plan-compose.ts`), le validateur
 * (`plan-validate.ts`) et les modules d'étapes (`steps-*.ts`).
 *
 * Avant ce module, chacun tenait sa propre copie de ces motifs — divergente sur le
 * domaine (le composeur acceptait les majuscules et n'importe quel TLD ; le validateur,
 * plus strict, les refusait) et absente côté chemin (le composeur ne contrôlait pas
 * `envFile` du tout). Un plan que le composeur jugeait valide pouvait donc échouer sa
 * propre validation — la revue finale en a trouvé 832 sur 2 688 compositions balayées.
 *
 * Le motif du validateur fait foi : c'est le plus strict, et c'est lui qui garde le
 * périmètre de sécurité (spec §6.1). Ce module existe pour que le composeur ne puisse
 * plus s'en écarter, pas l'inverse — ne relâche jamais ces motifs pour satisfaire le
 * composeur.
 */

/** Même règle que `PlanSchema.application` (`plan-types.ts`). */
export const APPLICATION_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Un nom d'hôte, sans schéma, sans chemin, sans port : minuscules uniquement, dernière
 * étiquette purement alphabétique d'au moins deux caractères. Pas de drapeau `/i` — un
 * domaine qui varie selon la casse composée puis validée romprait le déterminisme que
 * `plan_deployment` doit garantir.
 */
export const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

/** Le nôtre, et rien d'autre. `host` donnerait au conteneur la pile réseau de la machine. */
export const ALLOWED_NETWORK = "skynode"

/** Nom du conteneur posé par `proxy.caddy.install`. */
export const CADDY_CONTAINER = "skynode-caddy"

/** Un chemin relatif : segments alphanumériques, point, tiret, tiret bas, séparés par
 * `/`, ou `.` seul. Refuse l'espace et le saut de ligne au passage. */
const PATH_PATTERN = /^(\.|[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/

/**
 * Un chemin est refusé s'il est absolu, s'il contient un segment `..`, ou s'il ne
 * correspond pas à `PATH_PATTERN` — les trois contrôles, pas seulement le motif : un
 * motif seul se contourne par encodage.
 */
export function pathEscapes(path: string): boolean {
  if (path.startsWith("/")) return true
  if (path.split("/").includes("..")) return true
  return !PATH_PATTERN.test(path)
}

/* --------------------------------------------- garde-fous des recettes d'étapes --- */

/**
 * Refuse toute valeur qui n'a pas la forme imposée ci-dessus, **avant** qu'elle entre dans
 * un script d'étape.
 *
 * `plan-validate.ts` contrôle déjà le domaine et `PlanSchema` le nom d'application, mais une
 * recette est appelable directement : `recipeFor("proxy.caddy.site").script(…)` ne passe par
 * aucun des deux. Ce contrôle-ci est donc celui qui **autorise** les interpolations des
 * modules `steps-*.ts`, et c'est lui qu'il faut lire pour vérifier l'invariant n°1 du jalon.
 *
 * Il vit ici, et non dans chaque module d'étapes, pour la raison même qui a fait naître ce
 * fichier : deux copies d'une règle finissent par diverger, et c'est cette divergence-là qui
 * a coûté le plus cher au jalon précédent.
 */
export function exigeMotif(valeur: string, motif: RegExp, quoi: string): string {
  if (!motif.test(valeur)) {
    throw new Error(`« ${valeur} » n'est pas ${quoi} : aucun script ne peut être composé avec cette valeur.`)
  }

  return valeur
}

/**
 * Une recette ne doit jamais lire une étape d'un autre type : les champs qu'elle attend n'y
 * seraient pas, et TypeScript ne protège pas un exécuteur qui aurait perdu le lien entre le
 * type et la recette.
 */
export function exigeType<T extends PlanStep["type"]>(step: PlanStep, type: T): Extract<PlanStep, { type: T }> {
  if (step.type !== type) {
    throw new Error(`La recette de « ${type} » a reçu une étape de type « ${step.type} ».`)
  }

  return step as Extract<PlanStep, { type: T }>
}
