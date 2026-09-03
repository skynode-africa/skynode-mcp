import type { Plan, PlanStep } from "./plan-types.js"
import type { Violation } from "./plan-validate.js"

/**
 * Mise en forme française d'un plan de déploiement, de son refus et de ses violations.
 *
 * C'est ce texte, et rien d'autre, que le développeur approuve au jalon suivant
 * (`apply_plan`) avant qu'une seule commande ne s'exécute en root sur sa machine — jamais
 * un identifiant opaque, jamais du JSON. Trois règles, dans cet ordre de priorité : le
 * résumé en première ligne puis les étapes puis le hors-périmètre ; aucune valeur secrète
 * — `env.write` nomme le fichier, jamais son contenu ; sous 2 000 caractères, la longueur
 * qu'un humain lit avant de décider, pas un vidage de données. Même discipline que
 * `report.ts` au jalon 2.
 */

/**
 * Une ligne par étape, dans le vocabulaire du développeur — jamais le nom de type, que
 * les tests interdisent explicitement de laisser passer.
 */
export function renderStep(step: PlanStep): string {
  switch (step.type) {
    case "host.prepare":
      return step.swap_mo > 0
        ? `préparer la machine : utilisateur applicatif durci, pare-feu, fichier d'échange de ${step.swap_mo} Mio`
        : "préparer la machine : utilisateur applicatif durci, pare-feu"

    case "host.install_docker":
      return "installer Docker"

    case "proxy.caddy.install":
      return "installer Caddy comme reverse proxy"

    case "build.generate_dockerfile":
      return (
        `générer un Dockerfile pour ${step.famille} ${step.version}` +
        (step.gestionnaire ? ` (${step.gestionnaire})` : "") +
        `, écoute sur le port ${step.port}`
      )

    case "build.image":
      return `construire l'image ${step.tag} depuis ${step.source.path}`

    case "env.write":
      // Le nom du fichier suffit à décider ; sa valeur ferait transiter les secrets du
      // client par le contexte de l'agent — jamais rendue ici.
      return `écrire les variables d'environnement dans le conteneur, copiées depuis ${step.depuis} (les valeurs ne sont ni lues ni affichées ici)`

    case "app.run":
      return `démarrer le conteneur sur le réseau ${step.reseau}, port interne ${step.port_interne}`

    case "proxy.caddy.site":
      return `publier sur ${step.domaine} en HTTPS (certificat obtenu automatiquement, port 443)`

    case "state.record":
      return "enregistrer l'état du déploiement sur la machine"
  }
}

/** Un plan complet ne dépasse pas ce seuil ; borne les listes plutôt que d'y couper à l'aveugle. */
const MAX_HORS_PERIMETRE = 20

export function formatPlan(plan: Plan): string {
  const lines: string[] = [plan.resume, ""]

  lines.push("Étapes :")
  plan.etapes.forEach((step, index) => {
    lines.push(`${index + 1}. ${renderStep(step)}`)
  })

  lines.push("", `Application : ${plan.application}`)

  const domaine = plan.etapes.find(
    (step): step is Extract<PlanStep, { type: "proxy.caddy.site" }> => step.type === "proxy.caddy.site"
  )
  if (domaine) {
    lines.push(`Domaine : ${domaine.domaine}`)
  }

  lines.push(plan.reversible ? "Ce plan est réversible." : "Ce plan est irréversible : il ne pourra pas être annulé.")

  if (plan.hors_perimetre.length > 0) {
    const shown = plan.hors_perimetre.slice(0, MAX_HORS_PERIMETRE)
    lines.push("", "Hors périmètre :", ...shown.map((h) => `- ${h}`))
  }

  return lines.join("\n")
}

/**
 * Un refus est un constat, jamais une panne : le motif d'abord, la marche à suivre
 * ensuite — même règle qu'au jalon 2 (`report.ts`, `regime.ts`). Aucun mot du champ
 * lexical de l'échec ; un agent qui lirait « erreur » chercherait à réessayer une
 * opération que rien ne rendra différente.
 */
export function formatRefusal(because: string, guidance: string[]): string {
  const lines: string[] = [because]

  if (guidance.length > 0) {
    lines.push("", "Marche à suivre :", ...guidance.map((g, i) => `${i + 1}. ${g}`))
  }

  return lines.join("\n")
}

const REGLE_LABELS: Record<Violation["regle"], string> = {
  empreinte: "État de la machine",
  dependances: "Ordre et dépendances",
  contradiction: "Contradiction avec l'état constaté",
  regime: "Régime de la machine",
  bornes: "Valeur hors limites",
}

/**
 * L'ordre des règles reprend celui de `plan-validate.ts` (règles 2, 3, 4, 5, 6 de la
 * spec §6.1 — la règle 1, le schéma, est déjà tranchée par `parsePlan`), pas l'ordre
 * d'arrivée des violations dans le tableau.
 */
const REGLE_ORDER: Violation["regle"][] = ["empreinte", "dependances", "contradiction", "regime", "bornes"]

/**
 * Les 24 messages de `plan-validate.ts` qui portent un `etape` font tous naître leur
 * texte du même gabarit littéral : `étape ${index}` (base 0) suivi d'un espace puis soit
 * `(type)`, soit `:`. Reconnaître ce début exact — jamais en extraire le reste par
 * analyse de texte — permet de réécrire seulement le nombre, sans perdre le nom de type
 * qu'il porte parfois entre parenthèses.
 *
 * Un message qui ne commence pas par ce gabarit (un texte composé à la main, ou un
 * message futur écrit autrement) ne matche pas : on garde le repli d'origine, un
 * préfixe « étape N : » ajouté devant, plutôt que de risquer une réécriture incorrecte.
 */
function embeddedEtapePrefix(etapeZeroBased: number): RegExp {
  return new RegExp(`^étape ${etapeZeroBased}(?=\\s[:(])`)
}

/**
 * Base 1 : un développeur qui lit « étape 2 » compte à partir de un, `Violation.etape`
 * reste un index de tableau. Sans ce repérage, un message qui embarque déjà sa propre
 * référence en base 0 (voir `embeddedEtapePrefix`) se retrouverait doublement indexé —
 * deux nombres différents pour le même fait, sans rien qui dise qu'ils ne comptent pas
 * de la même façon.
 */
function withEtape(message: string, etape: number | undefined): string {
  if (etape === undefined) return message

  const prefix = embeddedEtapePrefix(etape)
  if (prefix.test(message)) {
    return message.replace(prefix, `étape ${etape + 1}`)
  }

  return `étape ${etape + 1} : ${message}`
}

/**
 * Groupe les violations par règle et dit quoi corriger — jamais de vocabulaire d'erreur
 * interne (« exception », « stack », « undefined ») : c'est un constat contre le plan
 * soumis, pas une panne de ce module.
 */
export function formatViolations(violations: Violation[]): string {
  const lines: string[] = ["Ce plan ne peut pas être appliqué tel quel :"]

  for (const regle of REGLE_ORDER) {
    const groupe = violations.filter((v) => v.regle === regle)
    if (groupe.length === 0) continue

    lines.push("", `${REGLE_LABELS[regle]} :`)
    lines.push(...groupe.map((v) => `- ${withEtape(v.message, v.etape)}`))
  }

  return lines.join("\n")
}
