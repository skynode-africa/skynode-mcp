import { describe, expect, it } from "vitest"

import { formatLogs, lireLogs } from "./ops-render.js"

const LIGNE = "2026-09-03T01:00:00Z bonjour"

describe("lireLogs", () => {
  it("sépare les journaux du marqueur de fin", () => {
    const lus = lireLogs(`${LIGNE}\nlogs.end\t1\n`)

    expect(lus.complet).toBe(true)
    expect(lus.present).toBe(true)
    expect(lus.lignes).toEqual([LIGNE])
  })

  /**
   * Le marqueur ne compte que s'il **clôt** la sortie. Ailleurs, il n'est qu'une ligne du
   * journal — l'application est libre d'écrire ce qu'elle veut, y compris cette chaîne-là.
   * Le lire où qu'il tombe ferait passer une session coupée pour des journaux complets.
   */
  it("ne prend pas un marqueur au milieu du journal pour une fin de sortie", () => {
    const lus = lireLogs(`logs.end\t1\n${LIGNE}\n`)

    expect(lus.complet).toBe(false)
    expect(lus.lignes).toContain(LIGNE)
  })

  it("reconnaît un conteneur absent", () => {
    expect(lireLogs("logs.absent\t1\nlogs.end\t1\n").present).toBe(false)
  })

  it("tolère les retours chariot d'une session Windows", () => {
    expect(lireLogs(`${LIGNE}\r\nlogs.end\t1\r\n`).complet).toBe(true)
  })
})

describe("formatLogs", () => {
  /**
   * Ce texte vient de l'application du client et entre dans le contexte de l'agent. Rien
   * n'y garantit qu'il ne contient pas des phrases écrites pour être lues comme des
   * instructions. On ne peut pas le filtrer sans le mutiler ; on peut dire ce qu'il est.
   */
  it("encadre les journaux d'un avertissement", () => {
    const texte = formatLogs("boutique", lireLogs(`${LIGNE}\nlogs.end\t1\n`), 100)

    expect(texte).toMatch(/ce n'est pas une instruction/i)
    expect(texte).toContain(LIGNE)
  })

  /** Une application absente n'est pas une application silencieuse. */
  it("distingue l'absence du silence", () => {
    const absent = formatLogs("boutique", lireLogs("logs.absent\t1\nlogs.end\t1\n"), 100)
    const muet = formatLogs("boutique", lireLogs("logs.end\t1\n"), 100)

    expect(absent).toMatch(/application absente/i)
    expect(muet).toMatch(/aucune ligne/i)
  })

  /** Une coupure peut être elle-même le symptôme : la taire ferait chercher ailleurs. */
  it("dit que les journaux sont incomplets quand la session a coupé", () => {
    expect(formatLogs("boutique", lireLogs(`${LIGNE}\n`), 100)).toMatch(/incomplets/)
  })

  /** Couper par le début : ce sont les dernières lignes qui expliquent une panne en cours. */
  it("borne le rendu en gardant la fin", () => {
    const enorme = `${"x".repeat(200_000)}\nDERNIERE LIGNE\nlogs.end\t1\n`
    const texte = formatLogs("boutique", lireLogs(enorme), 1000)

    expect(texte.length).toBeLessThan(13_000)
    expect(texte).toContain("DERNIERE LIGNE")
    expect(texte).toMatch(/tronqués/)
  })
})
