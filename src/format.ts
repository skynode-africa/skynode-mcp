import type { Instance } from "./api.js"

/**
 * Mise en forme à destination d'un agent.
 *
 * Un agent lit du texte, et chaque jeton dépensé à décoder un code d'état est un jeton
 * de moins pour la tâche du développeur. Chaque état est donc rendu avec **ce qu'il
 * implique** : un serveur `PROVISIONING` sera prêt sans intervention, un `SUSPENDED`
 * réclame un paiement. Sans cela, l'agent propose d'agir là où il n'y a rien à faire.
 */

/** Ce que chaque état signifie pour la suite des opérations. */
export const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "en attente de paiement — le serveur sera créé une fois le paiement confirmé",
  PROVISIONING: "en cours de livraison — il sera prêt sans intervention, en quelques minutes",
  PROVISIONING_FAILED: "échec de livraison — le support SkyNode a été alerté",
  RUNNING: "en fonctionnement",
  RESCUE: "en mode secours — le disque n'a pas démarré ; on en sort par un redémarrage",
  STOPPED: "arrêté",
  SUSPENDED: "suspendu pour impayé — un paiement le remet en service",
  CANCELLED: "résiliation demandée — il fonctionne jusqu'à son échéance",
  TERMINATED: "résilié — il n'est plus accessible",
}

/** Le hostname est facultatif à la commande : sans repli, la ligne dirait « null ». */
function nameOf(instance: Instance): string {
  return instance.hostname ?? `serveur ${instance.region}`
}

function statusOf(instance: Instance): string {
  return STATUS_LABELS[instance.status] ?? instance.status
}

/** Jour/mois/année : la convention de lecture du marché visé. */
function formatDate(iso: string | null): string {
  if (!iso) return "—"

  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return "—"

  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" }).format(date)
}

/**
 * Une adresse absente n'est pas une anomalie avant la livraison. Le dire évite que
 * l'agent la présente comme une donnée manquante, voire corrompue.
 */
function addressOf(instance: Instance): string {
  if (instance.ipv4) return instance.ipv4

  return "pas encore attribuée"
}

export function formatInstanceLine(instance: Instance): string {
  return `- ${nameOf(instance)} — ${addressOf(instance)} — ${statusOf(instance)}\n  id : ${instance.id}`
}

export function formatInstanceList(instances: Instance[]): string {
  /*
    Le cas d'un compte neuf. Rendre une chaîne vide laisserait l'agent conclure à une
    panne et relancer l'appel ; il doit lire qu'il n'y a rien, et quoi faire ensuite.
  */
  if (instances.length === 0) {
    return (
      "Vous n'avez aucun serveur SkyNode pour le moment. " +
      "Commandez-en un sur skynode.africa, ou depuis votre espace client."
    )
  }

  const total = instances.length
  const heading = total === 1 ? "1 serveur :" : `${total} serveurs :`

  return [heading, ...instances.map(formatInstanceLine)].join("\n")
}

export function formatInstanceDetail(instance: Instance): string {
  const lines = [
    `${nameOf(instance)} (${instance.id})`,
    `État : ${statusOf(instance)}`,
    `Adresse IPv4 : ${addressOf(instance)}`,
  ]

  if (instance.ipv6) {
    lines.push(`Adresse IPv6 : ${instance.ipv6}`)
  }

  lines.push(
    `Système : ${instance.osImage}`,
    `Région : ${instance.region}`,
    `Utilisateur SSH : ${instance.defaultUser ?? "—"}`,
    `Facturation : ${instance.cycle === "YEARLY" ? "annuelle" : "mensuelle"}`,
    `Prochaine échéance : ${formatDate(instance.nextRenewalAt)}`,
    `Livré le : ${formatDate(instance.provisionedAt)}`,
    `Plan : ${instance.planId}`
  )

  return lines.join("\n")
}
