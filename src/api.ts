import type { Config } from "./config.js"

/**
 * Client HTTP de l'API SkyNode.
 *
 * Deux responsabilités, et deux seulement : déballer l'enveloppe imposée par
 * l'intercepteur global de l'API, et traduire ses échecs en messages qu'un agent peut
 * exploiter. Un agent qui lit « Request failed » réessaie en boucle ; un agent qui lit
 * « votre jeton n'a pas la portée instances:read » le rapporte à son utilisateur.
 */

/** Au-delà, l'agent attend sans rien pouvoir dire à son utilisateur. */
const TIMEOUT_MS = 15_000

/**
 * L'API pagine. Cent instances dépassent largement le parc d'un client ; au-delà,
 * c'est une page qu'il faudrait, pas une limite plus haute.
 */
const PAGE_LIMIT = 100

/** Les seuls champs que ce jalon lit. L'API en rend davantage. */
export interface Instance {
  id: string
  hostname: string | null
  status: string
  ipv4: string | null
  ipv6: string | null
  region: string
  osImage: string
  planId: string
  cycle: string
  defaultUser: string | null
  nextRenewalAt: string | null
  provisionedAt: string | null
  createdAt: string
}

export class SkyNodeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "SkyNodeError"
  }
}

interface Envelope<T> {
  success: boolean
  data: T
}

export class SkyNodeApi {
  constructor(private readonly config: Config) {}

  async listInstances(): Promise<Instance[]> {
    return this.request<Instance[]>(`/instances?limit=${PAGE_LIMIT}`)
  }

  async getInstance(id: string): Promise<Instance> {
    /*
      Un identifiant est un UUID venu de `list_servers`, mais il transite par l'agent —
      donc potentiellement par du texte lu dans un dépôt. Le laisser construire le
      chemin permettrait à `../../auth/me`, ou pire à une URL absolue, de rediriger
      l'en-tête `Authorization` vers un hôte tiers.
    */
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new SkyNodeError(
        400,
        `« ${id} » n’est pas un identifiant de serveur. Utilisez celui que list_servers a rendu.`
      )
    }

    return this.request<Instance>(`/instances/${id}`)
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response

    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error: unknown) {
      // DNS, connexion refusée, délai dépassé : rien de tout cela n'a d'enveloppe.
      throw new SkyNodeError(
        0,
        `Impossible de joindre l’API SkyNode (${this.config.baseUrl}). ` +
          `Vérifiez votre connexion. Détail : ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (!response.ok) {
      throw new SkyNodeError(response.status, explain(response.status))
    }

    let body: Envelope<T>

    try {
      body = (await response.json()) as Envelope<T>
    } catch (error: unknown) {
      // Un proxy d'entreprise, un portail Wi-Fi captif ou une page d'erreur
      // d'infrastructure répondent couramment 200 avec du HTML : la requête a abouti,
      // mais pas au bon endroit. Réessayer à l'identique ne changera rien — ce n'est
      // pas une panne temporaire du service.
      throw new SkyNodeError(
        response.status,
        "La réponse de l’API SkyNode n’a pas la forme attendue (JSON). " +
          "Un intermédiaire réseau (proxy, portail captif) a probablement répondu à sa " +
          `place. Détail : ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return body.data
  }
}

/**
 * Traduction des refus.
 *
 * Chaque message dit **ce qui s'est passé et quoi faire**. Un agent n'a aucun moyen de
 * deviner qu'un 403 vient d'une portée manquante plutôt que d'un droit d'administration,
 * et il réessaierait indéfiniment.
 */
function explain(status: number): string {
  if (status === 401) {
    return (
      "Jeton refusé : il a été révoqué, a expiré, ou le compte est suspendu. " +
      "Créez-en un nouveau sur /compte/securite."
    )
  }

  if (status === 403) {
    return (
      "Ce jeton n’a pas la portée « instances:read », nécessaire pour lire vos serveurs. " +
      "Créez-en un nouveau en cochant cette portée sur /compte/securite."
    )
  }

  if (status === 404) {
    return "Ce serveur n’existe pas, ou n’appartient pas à votre compte."
  }

  if (status === 429) {
    return "Trop de requêtes d’affilée vers l’API SkyNode. Patientez une minute avant de réessayer."
  }

  if (status >= 500) {
    return "L’API SkyNode est momentanément indisponible. Réessayez dans un instant."
  }

  return `L’API SkyNode a refusé la requête (code ${status}).`
}
