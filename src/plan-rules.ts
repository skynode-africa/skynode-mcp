/**
 * Règles partagées entre le composeur (`plan-compose.ts`) et le validateur
 * (`plan-validate.ts`).
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
