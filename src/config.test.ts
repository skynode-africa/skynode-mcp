import { describe, expect, it } from "vitest"

import { readConfig } from "./config.js"

describe("readConfig", () => {
  it("lit le jeton et applique l'URL par défaut", () => {
    expect(readConfig({ SKYNODE_TOKEN: "sky_abc" })).toEqual({
      token: "sky_abc",
      baseUrl: "https://api.skynode.africa/api/v1",
    })
  })

  /**
   * Le message doit nommer la variable attendue et l'écran qui produit la valeur.
   * « Configuration invalide » enverrait le développeur lire le code source.
   */
  it("explique quoi faire quand le jeton manque", () => {
    expect(() => readConfig({})).toThrow(/SKYNODE_TOKEN/)
    expect(() => readConfig({})).toThrow(/compte\/securite/)
  })

  /**
   * Un jeton sans le préfixe est presque toujours un JWT de session copié depuis les
   * outils de développement du navigateur. Le dire évite une enquête sur des 401 que
   * rien n'expliquerait.
   */
  it("refuse une valeur qui n'est pas un jeton personnel", () => {
    expect(() => readConfig({ SKYNODE_TOKEN: "eyJhbGciOiJIUzI1NiJ9.a.b" })).toThrow(
      /sky_/
    )
    expect(() => readConfig({ SKYNODE_TOKEN: "eyJhbGciOiJIUzI1NiJ9.a.b" })).toThrow(
      /compte\/securite/
    )
  })

  it("accepte une URL d'API explicite", () => {
    expect(
      readConfig({ SKYNODE_TOKEN: "sky_abc", SKYNODE_API_URL: "http://localhost:3001/api/v1" })
    ).toEqual({ token: "sky_abc", baseUrl: "http://localhost:3001/api/v1" })
  })

  /**
   * Une barre oblique finale doublerait le séparateur (`…/api/v1//instances`). Nginx
   * et beaucoup de routeurs répondent 404 sur cette forme.
   */
  it("retire la barre oblique finale", () => {
    expect(
      readConfig({ SKYNODE_TOKEN: "sky_abc", SKYNODE_API_URL: "https://api.example/api/v1/" })
        .baseUrl
    ).toBe("https://api.example/api/v1")
  })
})
