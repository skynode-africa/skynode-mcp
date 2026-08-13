import { describe, expect, it } from "vitest"

import type { Instance } from "./api.js"
import { formatInstanceDetail, formatInstanceList } from "./format.js"

const base: Instance = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  hostname: "boutique",
  status: "RUNNING",
  ipv4: "203.0.113.10",
  ipv6: null,
  region: "EU",
  osImage: "ubuntu-24-04",
  planId: "9a1b2c3d-4e5f-6789-abcd-ef0123456789",
  cycle: "MONTHLY",
  defaultUser: "root",
  nextRenewalAt: "2026-09-13T00:00:00.000Z",
  provisionedAt: "2026-08-01T10:00:00.000Z",
  createdAt: "2026-08-01T09:00:00.000Z",
}

describe("formatInstanceList", () => {
  /**
   * Une liste vide n'est pas une erreur, et c'est le cas d'un nouveau client. Le dire
   * évite qu'un agent conclue à une panne et relance l'appel.
   */
  it("dit clairement qu'il n'y a aucun serveur", () => {
    const text = formatInstanceList([])

    expect(text).toMatch(/aucun serveur/i)
    expect(text).not.toMatch(/erreur/i)
  })

  it("rend une ligne par serveur, avec l'identifiant", () => {
    const text = formatInstanceList([base])

    expect(text).toContain("boutique")
    expect(text).toContain("203.0.113.10")
    expect(text).toContain(base.id)
  })

  /**
   * Le hostname est facultatif à la commande. Sans repli, la ligne commencerait par
   * « null » et l'agent le prendrait pour un nom.
   */
  it("nomme un serveur sans hostname par sa région", () => {
    const text = formatInstanceList([{ ...base, hostname: null }])

    expect(text).not.toContain("null")
    expect(text).toContain("EU")
  })
})

describe("formatInstanceDetail", () => {
  /**
   * Le point qui fait la différence : un agent ne sait pas ce que veut dire
   * `PROVISIONING`. Il doit lire que le serveur sera prêt sans intervention, sinon il
   * proposera à son utilisateur d'agir alors qu'il n'y a rien à faire.
   */
  it("explique un état de livraison en cours", () => {
    const text = formatInstanceDetail({ ...base, status: "PROVISIONING", ipv4: null })

    expect(text).toMatch(/en cours de livraison/i)
    expect(text).toMatch(/sans intervention/i)
  })

  it("explique qu'un serveur suspendu attend un paiement", () => {
    const text = formatInstanceDetail({ ...base, status: "SUSPENDED" })

    expect(text).toMatch(/impayé|paiement/i)
  })

  /**
   * `RESCUE` existe justement parce que le confondre avec `PROVISIONING` annonçait
   * « en préparation » à un client dont le serveur est en panne.
   */
  it("distingue le mode secours d'une livraison", () => {
    const text = formatInstanceDetail({ ...base, status: "RESCUE" })

    expect(text).toMatch(/secours/i)
    expect(text).not.toMatch(/livraison/i)
  })

  it("annonce l'échéance en clair", () => {
    expect(formatInstanceDetail(base)).toContain("13/09/2026")
  })

  /**
   * Une IP absente est normale avant la livraison. Afficher « null » ferait croire à
   * une donnée corrompue.
   */
  it("dit pourquoi l'adresse IP manque", () => {
    const text = formatInstanceDetail({ ...base, status: "PROVISIONING", ipv4: null })

    expect(text).not.toContain("null")
    expect(text).toMatch(/pas encore/i)
  })

  /**
   * Le jalon 1 ne sait pas si le serveur est préparé — l'état vit sur le serveur et
   * n'existe qu'à partir du jalon 2. Le taire vaut mieux que l'inventer, mais l'outil
   * ne doit rien affirmer qui suggère le contraire.
   */
  it("n'affirme rien sur la préparation du serveur", () => {
    const text = formatInstanceDetail(base)

    expect(text).not.toMatch(/préparé/i)
  })
})
