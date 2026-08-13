import { afterEach, describe, expect, it, vi } from "vitest"

import { SkyNodeApi, SkyNodeError } from "./api.js"

const config = { token: "sky_abc", baseUrl: "https://api.test/api/v1" }

/** Réponse de l'API enveloppée comme le fait son intercepteur global. */
const envelope = (data: unknown, meta?: unknown) =>
  new Response(JSON.stringify({ success: true, data, meta }), { status: 200 })

const failure = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status })

afterEach(() => {
  // `restoreAllMocks` ne défait pas `stubGlobal` : sans cette ligne, le `fetch` simulé
  // du dernier test fuiterait dans les suivants, et l'échec se lirait dans un fichier
  // qui n'a rien fait de mal.
  vi.unstubAllGlobals()
})

describe("SkyNodeApi", () => {
  it("présente le jeton en Bearer et déballe l’enveloppe", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope([{ id: "i-1" }]))
    vi.stubGlobal("fetch", fetchMock)

    const instances = await new SkyNodeApi(config).listInstances()

    expect(instances).toEqual([{ id: "i-1" }])

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/api/v1/instances?limit=100")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sky_abc")
  })

  /**
   * Le jeton ne doit jamais partir ailleurs que chez SkyNode : un identifiant qui
   * contiendrait `../` ou une URL absolue redirigerait l'en-tête `Authorization` vers
   * un hôte tiers.
   */
  it("refuse un identifiant qui sortirait du chemin", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(new SkyNodeApi(config).getInstance("../../auth/me")).rejects.toThrow(
      /identifiant/i
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * 403 sur ces routes ne peut signifier qu'une chose : le jeton existe et il est
   * valide, mais il n'a pas la portée. Le dire évite que l'agent croie le serveur en
   * panne et réessaie.
   */
  it("traduit un 403 en défaut de portée", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(403, "FORBIDDEN", "Forbidden")))

    await expect(new SkyNodeApi(config).listInstances()).rejects.toThrow(/instances:read/)
  })

  it("traduit un 401 en jeton invalide ou révoqué", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(401, "UNAUTHORIZED", "Invalid")))

    await expect(new SkyNodeApi(config).listInstances()).rejects.toThrow(/révoqué|expiré/)
  })

  it("traduit un 404 en serveur introuvable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(404, "NOT_FOUND", "Not found")))

    await expect(new SkyNodeApi(config).getInstance("i-1")).rejects.toThrow(/n’existe pas/)
  })

  /**
   * Le plafond est celui du compte, pas de l'IP : réessayer immédiatement le
   * consommerait davantage. L'agent doit lire une durée, pas un code.
   */
  it("traduit un 429 en invitation à patienter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(429, "TOO_MANY", "Slow down")))

    await expect(new SkyNodeApi(config).listInstances()).rejects.toThrow(/minute/)
  })

  /**
   * `fetch` rejette sur DNS ou connexion refusée. Sans traduction, l'agent verrait une
   * pile Node brute au milieu de sa conversation.
   */
  it("traduit une panne réseau", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))

    await expect(new SkyNodeApi(config).listInstances()).rejects.toThrow(/joindre/)
  })

  it("expose le statut sur l’erreur", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(403, "FORBIDDEN", "Forbidden")))

    await expect(new SkyNodeApi(config).listInstances()).rejects.toBeInstanceOf(SkyNodeError)
    // La valeur, pas seulement le type : une régression qui renverrait toujours
    // `status: 0` doit faire échouer ce test.
    await expect(new SkyNodeApi(config).listInstances()).rejects.toMatchObject({ status: 403 })
  })

  /**
   * Un proxy d'entreprise, un portail Wi-Fi captif ou une page d'erreur d'infrastructure
   * répondent couramment 200 avec du HTML. Sans traduction, `response.json()` lèverait un
   * `SyntaxError` brut — exactement la pile Node que ce module se donne pour mission
   * d'éviter.
   */
  it("traduit un 200 au corps non-JSON en réponse de forme inattendue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })))

    await expect(new SkyNodeApi(config).listInstances()).rejects.toBeInstanceOf(SkyNodeError)
    await expect(new SkyNodeApi(config).listInstances()).rejects.toThrow(
      /forme attendue|inattendu/i
    )
  })
})
