import { describe, expect, it } from "vitest"

import type { PlanStep } from "./plan-types.js"
import type { StepContext } from "./step.js"
import { recipeFor, verifieConformiteScript } from "./step.js"
import {
  ATTENTE_CERTIFICAT_S,
  CHEMIN_CADDYFILE,
  ETIQUETTE_PORT,
  IMAGE_CADDY,
  LIGNE_IMPORT,
  REPERTOIRE_SITES,
  VOLUME_CONFIG,
  VOLUME_DONNEES,
} from "./steps-proxy.js"

const ctx: StepContext = {
  application: "boutique",
  projectRoot: "/home/dev/boutique",
  workDir: "/opt/skynode/work/boutique",
}

const install: PlanStep = { type: "proxy.caddy.install" }
const site: PlanStep = { type: "proxy.caddy.site", domaine: "boutique.exemple.ci" }

/**
 * **Le domaine dont la première étiquette ne ressemble en rien au nom d'application.**
 *
 * L'exemple du plan faisait coïncider les deux (`boutique` / `boutique.exemple.ci`), ce qui
 * masque le seul défaut qui compte ici : dériver le nom de fichier ou de conteneur du
 * domaine ferait se recouvrir `app.exemple.ci` et `app.autre.ci` sur un même `app.caddy`, et
 * router vers un conteneur qui n'existe pas.
 */
const siteAutreDomaine: PlanStep = { type: "proxy.caddy.site", domaine: "www.autre-nom.exemple.ci" }

const scriptInstall = (): string => recipeFor("proxy.caddy.install").script(install, ctx)
const undoInstall = (): string => recipeFor("proxy.caddy.install").undoScript(install, ctx) ?? ""
const scriptSite = (etape: PlanStep = site): string => recipeFor("proxy.caddy.site").script(etape, ctx)
const undoSite = (etape: PlanStep = site): string =>
  recipeFor("proxy.caddy.site").undoScript(etape, ctx) ?? ""

/**
 * Les lignes du script, continuations `\` recollées.
 *
 * Sans ce recollage, un contrôle ligne à ligne lit `docker run -d \` seul et n'y voit
 * aucune redirection — alors que le `>&2` est huit lignes plus bas, sur la même commande.
 */
function lignesLogiques(script: string): string[] {
  const sorties: string[] = []
  let courante = ""

  for (const ligne of script.split("\n")) {
    if (ligne.endsWith("\\")) {
      courante += `${ligne.slice(0, -1)} `
      continue
    }
    sorties.push(courante + ligne)
    courante = ""
  }
  if (courante !== "") sorties.push(courante)

  return sorties
}

describe("proxy.caddy.install", () => {
  it("crée le réseau interne avant le conteneur", () => {
    const s = scriptInstall()

    expect(s).toContain("network create skynode")
    expect(s).toContain("run -d")
    expect(s.indexOf("network create skynode")).toBeLessThan(s.indexOf("run -d"))
  })

  /**
   * Sans volumes nommés, chaque redémarrage redemande les certificats — et Let's Encrypt
   * plafonne à cinq échecs de validation par heure et par domaine. Un proxy qui repart deux
   * fois dans l'après-midi coûterait au client son HTTPS jusqu'au lendemain.
   */
  it("monte des volumes nommés pour les certificats et la configuration", () => {
    const s = scriptInstall()

    expect(s).toMatch(new RegExp(`-v ${VOLUME_DONNEES}:/data`))
    expect(s).toMatch(new RegExp(`-v ${VOLUME_CONFIG}:/config`))
  })

  /**
   * `m[1]` est `string | undefined` sous `noUncheckedIndexedAccess` : le filtre n'est pas
   * un ornement, il est ce qui fait compiler l'assertion sans mentir sur son contenu.
   */
  it("ne publie que 80 et 443", () => {
    const ports = [...scriptInstall().matchAll(/-p (\d+):/g)]
      .map((m) => m[1])
      .filter((p): p is string => p !== undefined)

    expect(ports.length).toBeGreaterThan(0)
    expect(new Set(ports)).toEqual(new Set(["80", "443"]))
  })

  /**
   * Une étiquette flottante ferait dépendre du jour la version qui tourne chez le client :
   * une mise à jour majeure arriverait sans que personne ne l'ait décidée.
   */
  it("épingle la version de l'image, jusqu'au correctif", () => {
    const s = scriptInstall()

    expect(s).toMatch(/caddy:\d+\.\d+\.\d+/)
    expect(s).toContain(IMAGE_CADDY)
    expect(s).not.toMatch(/caddy:latest/)
  })

  /**
   * Un Caddy en marche sert peut-être déjà les autres applications de la machine : le
   * recréer couperait leur trafic pour un résultat identique. La garde doit donc sortir
   * **avant** la création, pas seulement exister quelque part.
   */
  it("ne recrée pas un Caddy déjà en marche", () => {
    const s = scriptInstall()

    expect(s).toContain("fin unchanged")
    expect(s.indexOf("fin unchanged")).toBeLessThan(s.indexOf("docker run -d"))
    expect(s).toMatch(/docker inspect -f '\{\{\.State\.Running\}\}' skynode-caddy .*grep -qx true; then/)
  })

  /** Invariant n°2 : on ne prend jamais un port tenu par quelqu'un d'autre. */
  it("constate 80 et 443 libres avant de créer le conteneur", () => {
    const s = scriptInstall()
    const constat = s.indexOf("ss -lntH")

    expect(constat).toBeGreaterThan(-1)
    expect(constat).toBeLessThan(s.indexOf("docker run -d"))
    // Le refus, pas seulement le constat : lire les ports sans en tirer de conséquence
    // laisserait Docker prendre la décision à notre place.
    expect(s).toMatch(/if \[ -n "\$tenus" \]; then\n\s*echec /)
  })

  /**
   * Invariant n°4 : une étape qui échoue en cours de route défait ce qu'elle a commencé.
   * `docker run -d` rend 0 sur un conteneur qui sortira dans la seconde — un Caddyfile
   * refusé, typiquement. Sans ce constat, l'étape rendrait `applied` sur un proxy éteint.
   */
  it("retire le conteneur qui démarre puis s'arrête aussitôt", () => {
    const s = scriptInstall()
    const apresRun = s.slice(s.indexOf("docker run -d"))

    expect(apresRun).toMatch(/docker inspect -f '\{\{\.State\.Running\}\}' skynode-caddy/)
    expect(apresRun).toContain("docker logs")
    expect(apresRun).toMatch(/docker rm -f skynode-caddy/)
    expect(apresRun).toContain("echec ")
  })

  /**
   * Le `Caddyfile` principal est **le seul fichier de ce produit qui puisse préexister**.
   * L'écraser effacerait la configuration d'un humain (spec §6.4).
   */
  it("ne crée le Caddyfile principal que s'il n'en existe aucun", () => {
    const s = scriptInstall()
    const garde = s.indexOf(`if [ ! -f '${CHEMIN_CADDYFILE}' ]; then`)
    const ecriture = s.indexOf(`cat > '${CHEMIN_CADDYFILE}'`)

    expect(garde).toBeGreaterThan(-1)
    expect(ecriture).toBeGreaterThan(garde)
  })

  /**
   * Le même chemin des deux côtés du montage : un humain qui lit
   * `import /etc/skynode/caddy/sites/*.caddy` dans le Caddyfile trouve les fichiers là où
   * la ligne le dit, au lieu d'un chemin qui n'existe que dans le conteneur.
   */
  it("monte la configuration en lecture seule, au même chemin des deux côtés", () => {
    expect(scriptInstall()).toContain("-v /etc/skynode/caddy:/etc/skynode/caddy:ro")
  })

  /**
   * `install -d` crée les répertoires manquants du chemin **au mode demandé** : un
   * `/etc/skynode` absent naîtrait en 0755 alors qu'il porte des secrets.
   */
  it("crée /etc/skynode à son propre mode, jamais par ricochet", () => {
    const s = scriptInstall()

    expect(s).toContain("install -d -m 0700 -o root -g root '/etc/skynode'")
    expect(s.indexOf("install -d -m 0700 -o root -g root '/etc/skynode'")).toBeLessThan(
      s.indexOf("install -d -m 0755 -o root -g root '/etc/skynode/caddy'")
    )
  })

  it("se défait en retirant le conteneur, jamais les volumes", () => {
    const u = undoInstall()

    expect(u).toMatch(/rm -f skynode-caddy/)
    expect(u).not.toMatch(/volume rm/)
    expect(u).not.toMatch(/volume prune/)
  })

  /**
   * Le réseau interne porte les conteneurs applicatifs, qui n'ont rien à voir avec Caddy :
   * le supprimer les couperait les uns des autres. Le `Caddyfile` principal, lui, peut
   * porter la configuration d'un humain.
   */
  it("se défait sans toucher au réseau interne ni au Caddyfile", () => {
    const u = undoInstall()

    expect(u).not.toMatch(/network rm/)
    expect(u).not.toContain(`rm -f '${CHEMIN_CADDYFILE}'`)
  })
})

describe("proxy.caddy.site", () => {
  it("écrit un fichier par application, pas un bloc dans un fichier partagé", () => {
    expect(scriptSite()).toContain(`${REPERTOIRE_SITES}/boutique.caddy`)
  })

  /**
   * **Le nom vient de `ctx.application`, jamais du domaine.** Le domaine et le nom
   * d'application sont indépendants (`DOMAIN_PATTERN` et `APPLICATION_PATTERN`) ; l'exemple
   * du plan les faisait coïncider, ce qui laissait passer un routage vers un conteneur
   * inexistant et deux domaines se disputant un même fichier de site.
   */
  it("nomme le fichier et le conteneur d'après l'application, jamais d'après le domaine", () => {
    const s = scriptSite(siteAutreDomaine)

    expect(s).toContain(`${REPERTOIRE_SITES}/boutique.caddy`)
    expect(s).toMatch(/reverse_proxy %s:%s\\n' 'boutique'/)
    // Ni la première étiquette du domaine, ni le domaine entier ne servent de nom.
    expect(s).not.toContain(`${REPERTOIRE_SITES}/www.caddy`)
    expect(s).not.toContain(`${REPERTOIRE_SITES}/autre-nom.caddy`)
    expect(s).not.toMatch(/reverse_proxy %s:%s\\n' 'www/)
    // Le domaine reste l'adresse du site, lui.
    expect(s).toContain("www.autre-nom.exemple.ci {")
  })

  it("route vers le conteneur par son nom sur le réseau interne", () => {
    expect(scriptSite()).toMatch(/reverse_proxy %s:%s\\n' 'boutique' "\$port"/)
  })

  /**
   * Le port n'est pas dans `ProxyCaddySite` — il vit dans `app.run`, que `plan-validate.ts`
   * exige plus haut dans le plan. Il se lit donc sur le conteneur applicatif, à
   * l'exécution : étiquette d'abord, port exposé de l'image à défaut.
   */
  it("lit le port sur le conteneur applicatif plutôt que de le deviner", () => {
    const s = scriptSite()

    expect(s).toContain(ETIQUETTE_PORT)
    expect(s).toContain(".Config.ExposedPorts")
    expect(s).toMatch(/docker inspect boutique >\/dev\/null 2>&1/)
  })

  /**
   * Router vers un port deviné serait pire que refuser : l'application paraîtrait déployée
   * et répondrait 502, sans que rien ne dise pourquoi.
   */
  it("refuse explicitement quand le port est introuvable ou ambigu", () => {
    const s = scriptSite()

    expect(s).toMatch(/if \[ "\$nb" = 1 \]/)
    expect(s).toMatch(/elif \[ "\$nb" = 0 \]; then\n\s*echec /)
    expect(s).toMatch(/else\n\s*echec .*ambigu/)
  })

  /**
   * Une étiquette Docker est du texte libre, que le `Dockerfile` du client peut porter :
   * c'est la seule valeur de ce module qui ne vienne pas de `plan-rules.ts`. Le contrôle
   * numérique est ce qui autorise son interpolation dans le Caddyfile.
   */
  it("borne le port à un nombre avant de l'écrire dans le Caddyfile", () => {
    const s = scriptSite()
    const bornage = s.lastIndexOf('case "$port" in')
    const ecriture = s.indexOf("reverse_proxy %s:%s")

    expect(bornage).toBeGreaterThan(-1)
    expect(s).toContain('""|0*|*[!0-9]*) echec ')
    expect(s).toContain('if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then')
    expect(bornage).toBeLessThan(ecriture)
  })

  /**
   * Une seule tentative, jamais de boucle : Let's Encrypt limite les échecs de validation à
   * cinq par heure et par domaine. Un agent qui réessaie bloque le domaine du client pour
   * l'après-midi.
   */
  it("attend le certificat une seule fois, avec un plafond", () => {
    const s = scriptSite()
    const attentes = [...s.matchAll(/^sleep \d+$/gm)]

    expect(attentes).toHaveLength(1)
    expect(s).toContain(`sleep ${String(ATTENTE_CERTIFICAT_S)}`)
    expect(s).not.toMatch(/while true/)
    expect(s).not.toMatch(/(^|\s)(while|until)\s/)
  })

  /**
   * **L'échéance n'est pas un échec.** Rendre `failed` ferait relancer le déploiement, donc
   * redemander le certificat — et consommer le plafond qu'on cherche justement à ménager.
   */
  it("ne fait pas échouer l'étape quand le certificat tarde", () => {
    const s = scriptSite()
    const apresAttente = s.slice(s.indexOf(`sleep ${String(ATTENTE_CERTIFICAT_S)}`))

    expect(apresAttente).not.toContain("echec ")
    expect(apresAttente).toContain("note ")
    expect(apresAttente).toContain('fin applied "$detail"')
  })

  it("se défait en supprimant son fichier et en rechargeant", () => {
    const u = undoSite()

    expect(u).toContain(`rm -f '${REPERTOIRE_SITES}/boutique.caddy'`)
    expect(u).toMatch(/caddy reload/)
  })

  /**
   * Le bloc d'import porte **tous** les sites de la machine : le retirer en défaisant une
   * seule application couperait le routage des autres.
   */
  it("se défait sans retirer l'import du Caddyfile principal", () => {
    const u = undoSite()

    expect(u).not.toContain("# >>> skynode-caddy >>>")
    expect(u).not.toContain(LIGNE_IMPORT)
  })

  /**
   * L'invariant de la spec §6.4 sur le seul fichier qui puisse préexister : un `Caddyfile`
   * portant une configuration humaine la conserve intacte, et n'accueille qu'un bloc marqué.
   */
  it("n'ajoute qu'un import marqué au Caddyfile principal", () => {
    const s = scriptSite()

    expect(s).toContain("# >>> skynode-caddy >>>")
    expect(s).toContain("# <<< skynode-caddy <<<")
    expect(s).toContain(LIGNE_IMPORT)
    expect(s).toContain(`import ${REPERTOIRE_SITES}/*.caddy`)
  })

  /**
   * Jamais de redirection simple sur le `Caddyfile` : elle le tronquerait à ce que SkyNode
   * y met, effaçant tout ce qu'un humain y avait écrit. Seuls un ajout en fin de fichier et
   * le `sed` de retrait du bloc y touchent.
   */
  it("n'écrase jamais le Caddyfile principal par une redirection", () => {
    const s = scriptSite()

    for (const ligne of s.split("\n")) {
      expect(ligne).not.toMatch(new RegExp(`[^>]>\\s*'${CHEMIN_CADDYFILE}'`))
    }
  })

  /**
   * Rejouée, l'étape doit rendre `unchanged` **sans recharger ni attendre** : un
   * rechargement inutile relancerait une demande ACME, ce que le plafond de Let's Encrypt
   * ne pardonne pas indéfiniment.
   */
  it("sort en unchanged avant tout rechargement et toute attente", () => {
    const s = scriptSite()
    const inchange = s.indexOf("fin unchanged")

    expect(inchange).toBeGreaterThan(-1)
    expect(s).toContain('if [ "$site_change" = non ] && [ "$import_change" = non ]; then')
    expect(inchange).toBeLessThan(s.indexOf("caddy reload"))
    expect(inchange).toBeLessThan(s.indexOf("sleep "))
  })

  /** L'import n'est reposé que s'il manque : sinon chaque passage réécrirait le bloc. */
  it("ne repose le bloc marqué que si la ligne d'import manque", () => {
    const s = scriptSite()
    const garde = s.indexOf(`if ! grep -q -F -x -- '${LIGNE_IMPORT}'`)
    const pose = s.indexOf("# >>> skynode-caddy >>>")

    expect(garde).toBeGreaterThan(-1)
    expect(pose).toBeGreaterThan(garde)
  })

  /**
   * `validate` avant `reload` : un rechargement refusé laisse Caddy sur son ancienne
   * configuration, mais le fichier fautif resterait sur le disque et ferait échouer le
   * prochain **démarrage** du conteneur — celui-là définitivement.
   */
  it("valide la configuration avant de la recharger", () => {
    const s = scriptSite()

    expect(s.indexOf("caddy validate")).toBeLessThan(s.indexOf("caddy reload"))
  })

  /**
   * Invariant n°4 : les deux chemins d'échec du rechargement remettent le fichier de site
   * comme il était. Sans cela, un déploiement fautif emporterait un site qui fonctionnait.
   */
  it("remet le fichier de site en place quand Caddy refuse la configuration", () => {
    const s = scriptSite()
    const appels = [...s.matchAll(/^\s*defaire_site$/gm)]

    expect(s).toContain("defaire_site() {")
    expect(appels).toHaveLength(2)
    expect(s).toMatch(/if \[ "\$avait_site" = oui \]; then\n\s*mv /)
    expect(s).toMatch(/else\n\s*rm -f '\/etc\/skynode\/caddy\/sites\/boutique\.caddy'\n\s*fi/)
  })
})

describe("les deux étapes", () => {
  const scripts: ReadonlyArray<readonly [string, string]> = [
    ["proxy.caddy.install", scriptInstall()],
    ["proxy.caddy.install (annulation)", undoInstall()],
    ["proxy.caddy.site", scriptSite()],
    ["proxy.caddy.site (annulation)", undoSite()],
  ]

  /** Le protocole de `runRemote` : un résultat, un détail, un marqueur de fin. */
  it.each(scripts)("%s rend le protocole d'étape", (_nom, s) => {
    expect(s).toContain("step.outcome")
    expect(s).toContain("step.detail")
    expect(s).toContain("step.end")
  })

  /** Sans droits, le script laisserait la machine à moitié configurée en croyant avoir agi. */
  it.each(scripts)("%s refuse de s'exécuter hors root", (_nom, s) => {
    expect(s).toContain('if [ "$(id -u)" != 0 ]; then')
  })

  /**
   * `stdout` porte le protocole d'étape que `runRemote` analyse. `docker run` y écrit un
   * identifiant de conteneur, `docker network create` celui du réseau, `docker logs` la
   * sortie de l'application : une seule de ces lignes suffirait à égarer l'analyseur.
   *
   * Et jamais `/dev/null` sur ce qui explique une panne : `runRemote` joint `stderr` au
   * diagnostic, `>&2` est donc ce qui rend l'échec lisible.
   */
  it.each(scripts)("%s ne laisse aucune commande bavarde écrire sur stdout", (_nom, s) => {
    const bavardes = /\bdocker (run|rm|start|logs|exec|network create|volume create)\b/

    for (const ligne of lignesLogiques(s)) {
      if (!bavardes.test(ligne)) continue
      expect(ligne).toMatch(/>&2|>\s*\/dev\/null|\|\s*grep/)
    }
  })

  /** Le harnais de `step.ts`, sur les deux types que ce module inscrit. */
  it("proxy.caddy.install passe les quatre contrôles", () => {
    expect(() => verifieConformiteScript("proxy.caddy.install", install, ctx)).not.toThrow()
  })

  it.each([
    ["domaine aligné sur l'application", site],
    ["domaine sans rapport avec l'application", siteAutreDomaine],
  ])("proxy.caddy.site passe les quatre contrôles (%s)", (_nom, etape) => {
    expect(() => verifieConformiteScript("proxy.caddy.site", etape, ctx)).not.toThrow()
  })
})

/**
 * Invariant n°1 : rien n'entre dans un script sans être passé par un motif de
 * `plan-rules.ts`. Une recette est appelable directement — `recipeFor(…).script(…)` ne
 * traverse ni `parsePlan` ni `plan-validate.ts` — donc le refus doit vivre ici aussi.
 */
describe("les valeurs refusées avant toute composition", () => {
  const domainesFautifs: ReadonlyArray<readonly [string, string]> = [
    ["une injection de commande", "exemple.ci; rm -rf /"],
    ["un schéma", "https://exemple.ci"],
    ["un chemin", "exemple.ci/admin"],
    ["un port", "exemple.ci:8443"],
    ["une majuscule", "Exemple.ci"],
    ["un nom d'hôte sans point", "localhost"],
    ["une substitution de commande", "$(id).exemple.ci"],
  ]

  it.each(domainesFautifs)("le domaine « %s » est refusé", (_nom, domaine) => {
    const etape = { type: "proxy.caddy.site", domaine } as PlanStep

    expect(() => recipeFor("proxy.caddy.site").script(etape, ctx)).toThrow(/domaine/)
    expect(() => recipeFor("proxy.caddy.site").undoScript(etape, ctx)).toThrow(/domaine/)
  })

  const applicationsFautives: ReadonlyArray<readonly [string, string]> = [
    ["une remontée de chemin", "../../etc/passwd"],
    ["une injection de commande", "boutique; id"],
    ["une majuscule", "Boutique"],
    ["un chiffre en tête", "1boutique"],
    ["le vide", ""],
  ]

  it.each(applicationsFautives)("le nom d'application « %s » est refusé", (_nom, application) => {
    const mauvais: StepContext = { ...ctx, application }

    expect(() => recipeFor("proxy.caddy.site").script(site, mauvais)).toThrow(/application/)
    expect(() => recipeFor("proxy.caddy.site").undoScript(site, mauvais)).toThrow(/application/)
  })

  /**
   * Une recette qui lirait une étape d'un autre type composerait un script à partir de
   * champs absents : lever nomme la confusion au lieu de produire un script incomplet.
   */
  /**
   * L'étiquette `skynode.port_interne` est la seule valeur de ce module qui ne vienne pas
   * de `plan-rules.ts` : c'est du texte libre, que le `Dockerfile` du client peut porter.
   * Une mutation a montré qu'un repli sur un port en dur passait la suite sans qu'aucun
   * test ne meure — l'application aurait alors paru déployée et répondu 502, sans que rien
   * ne dise pourquoi.
   */
  it("ramène une étiquette invalide à « inconnu », jamais à un port en dur", () => {
    const s = recipeFor("proxy.caddy.site").script(site, ctx)
    const normalisation = s.split("\n").find((l) => l.includes('*[!0-9]*'))

    expect(normalisation).toBeDefined()
    // Le seul aboutissement admis est la chaîne vide, qui passe la main au repli puis au
    // refus. Un chiffre ici serait un port supposé.
    expect(normalisation).toMatch(/port=""\s*;;/)
    expect(normalisation).not.toMatch(/port=[0-9]/)
  })

  it("une recette refuse une étape d'un autre type", () => {
    const autre: PlanStep = { type: "host.install_docker" }

    expect(() => recipeFor("proxy.caddy.install").script(autre, ctx)).toThrow(/proxy\.caddy\.install/)
    expect(() => recipeFor("proxy.caddy.site").script(autre, ctx)).toThrow(/proxy\.caddy\.site/)
    expect(() => recipeFor("proxy.caddy.install").undoScript(autre, ctx)).toThrow(/proxy\.caddy\.install/)
    expect(() => recipeFor("proxy.caddy.site").undoScript(autre, ctx)).toThrow(/proxy\.caddy\.site/)
  })
})
