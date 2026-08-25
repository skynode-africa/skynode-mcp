import { describe, expect, it, vi } from "vitest"

import {
  CHEMIN_DURCISSEMENT,
  CONFIG_DURCISSEMENT,
  hardenSsh,
  SCRIPT_DURCIT,
  SCRIPT_INCLUDE,
  SCRIPT_RETRAIT,
  SCRIPT_SONDE,
} from "./ssh-harden.js"
import type { SshResult, SshTarget } from "./ssh.js"

const target: SshTarget = { host: "192.0.2.10", user: "root" }

const ok = (stdout: string): SshResult => ({ code: 0, stdout, stderr: "" })

/**
 * Les réponses des quatre scripts, dans la forme qu'ils rendent réellement.
 *
 * **Ce n'est pas de la coquetterie.** Le plan proposait `mockResolvedValue(ok("x\t1"))` pour
 * tous les appels : la première vérification y lisait « pas d'Include », l'étape sortait
 * après **un seul** appel, et les boucles qui parcourent `run.mock.calls` ne parcouraient
 * donc rien. Deux tests passaient sans rien éprouver.
 */
const INCLUS = ok("harden.include\toui\nharden.end\t1\n")
const PAS_INCLUS = ok("harden.include\tnon\nharden.end\t1\n")
const SONDE_OK = ok("harden.sudo\toui\nharden.end\t1\n")
const SONDE_SANS_SUDO = ok("harden.sudo\tnon\nharden.end\t1\n")
const REFUS_SSH: SshResult = { code: 255, stdout: "", stderr: "Permission denied (publickey)." }
const RETRAIT_OK = ok("harden.recharge\toui\nharden.retire\toui\nharden.end\t1\n")

/** Ce que rend `SCRIPT_DURCIT` quand tout a pris effet. `ecrit` distingue pose et rejeu. */
const pose = (ecrit: "oui" | "non"): SshResult =>
  ok(
    [
      ...(ecrit === "oui" ? ["harden.recharge\toui"] : []),
      `harden.ecrit\t${ecrit}`,
      "harden.effectif\tpasswordauthentication no",
      "harden.effectif\tkbdinteractiveauthentication no",
      // La valeur que rend vraiment `sshd -T` pour `prohibit-password`, mesurée sur le banc.
      "harden.effectif\tpermitrootlogin without-password",
      "harden.end\t1",
      "",
    ].join("\n")
  )

/** Une pose où le fichier d'un tiers l'emporte : la découverte faite en production. */
const POSE_EN_CONFLIT = ok(
  [
    "harden.recharge\toui",
    "harden.ecrit\toui",
    "harden.effectif\tpasswordauthentication yes",
    "harden.effectif\tkbdinteractiveauthentication no",
    "harden.effectif\tpermitrootlogin without-password",
    "harden.conflit\tpasswordauthentication /etc/ssh/sshd_config.d/00-client.conf",
    "harden.end\t1",
    "",
  ].join("\n")
)

const erreur = (message: string): SshResult => ok(`harden.erreur\t${message}\nharden.end\t1\n`)

/** Le cas nominal en entier, pour les tests qui parcourent tous les appels. */
const chaineNominale = (): ReturnType<typeof vi.fn> =>
  vi
    .fn()
    .mockResolvedValueOnce(INCLUS)
    .mockResolvedValueOnce(SONDE_OK)
    .mockResolvedValueOnce(pose("oui"))
    .mockResolvedValueOnce(SONDE_OK)

describe("hardenSsh", () => {
  /** Le filet, dans son cas nominal. */
  it("durcit quand la seconde session fonctionne", async () => {
    const run = chaineNominale()
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("applied")
    expect(run).toHaveBeenCalledTimes(4)
  })

  /**
   * Le cas qui justifie toute la tâche : la configuration est écrite, rechargée, et la
   * session suivante ne passe plus. Le fichier DOIT être retiré et le service rechargé.
   */
  it("défait tout si la session d'après ne passe plus", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(pose("oui"))
      .mockResolvedValueOnce(REFUS_SSH)
      .mockResolvedValueOnce(RETRAIT_OK)
      // Le retrait ne se croit pas sur parole : une sixième session constate que la porte
      // s'est bien rouverte.
      .mockResolvedValueOnce(SONDE_OK)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/annulé|défait|rétabli/i)
    // La cinquième invocation est le retrait : elle DOIT avoir eu lieu.
    expect(run.mock.calls[4]?.[1]).toMatch(/rm -f \/etc\/ssh\/sshd_config\.d\/50-skynode\.conf/)
  })

  /**
   * Le retrait a bien eu lieu, et la porte se rouvre : le client doit lire que son serveur
   * est revenu exactement où il était, pas seulement que « ça a échoué ».
   */
  it("dit que le serveur est revenu dans son état d'avant quand la porte se rouvre", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(pose("oui"))
      .mockResolvedValueOnce(REFUS_SSH)
      .mockResolvedValueOnce(RETRAIT_OK)
      .mockResolvedValueOnce(SONDE_OK)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.detail).toMatch(/passe de nouveau/)
    expect(run).toHaveBeenCalledTimes(6)
  })

  /**
   * La porte ne se rouvre pas après le retrait : la cause est antérieure au durcissement, et
   * le dire évite d'envoyer le client chercher une panne que nous aurions causée. Le message
   * doit aussi rappeler que la session d'administration, elle, tient toujours — c'est la
   * seule information qui distingue « à réparer » de « console de secours ».
   */
  it("distingue une porte qui ne se rouvre pas d'un durcissement mal défait", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(pose("oui"))
      .mockResolvedValueOnce(REFUS_SSH)
      .mockResolvedValueOnce(RETRAIT_OK)
      .mockResolvedValueOnce(REFUS_SSH)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/ne passe toujours pas/)
    expect(r.detail).toMatch(/session d'administration/)
  })

  /** Le pire cas : on ne peut même plus retirer ce qu'on a posé. Il faut le dire en clair. */
  it("nomme le geste à faire à la main quand le retrait lui-même échoue", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(pose("oui"))
      .mockResolvedValueOnce(REFUS_SSH)
      .mockResolvedValueOnce(REFUS_SSH)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toContain(CHEMIN_DURCISSEMENT)
    expect(r.detail).toMatch(/à la main/)
    expect(r.detail).toMatch(/console de secours/)
  })

  /**
   * Sans `Include`, écrire dans sshd_config.d ne sert à rien — et laisserait croire le
   * serveur durci alors qu'il ne l'est pas. Mentir sur un durcissement est pire que ne
   * pas durcir.
   */
  it("ne durcit pas si sshd_config n'inclut pas le répertoire", async () => {
    const run = vi.fn().mockResolvedValueOnce(PAS_INCLUS)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("unchanged")
    expect(r.detail).toMatch(/Include/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  /** On ne coupe pas la corde avant d'avoir vérifié que l'autre tient. */
  it("ne touche à rien si la session applicative ne passe pas d'abord", async () => {
    const run = vi.fn().mockResolvedValueOnce(INCLUS).mockResolvedValueOnce(REFUS_SSH)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/clé|autorisée/i)
    expect(run).toHaveBeenCalledTimes(2)
  })

  /**
   * La session s'ouvre mais `sudo -n true` échoue : le compte applicatif ne pourrait pas
   * réparer un durcissement raté, ce qui revient au même qu'être enfermé dehors. Sans cette
   * garde, seule une session refusée arrêtait le durcissement.
   */
  it("ne durcit pas si le compte applicatif n'a pas d'élévation", async () => {
    const run = vi.fn().mockResolvedValueOnce(INCLUS).mockResolvedValueOnce(SONDE_SANS_SUDO)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/sudo/)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("ne recharge pas si sshd -t refuse la configuration", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(
        erreur(
          "« sshd -t » refuse la configuration une fois le fichier de SkyNode posé : il a été retiré et le service n'a pas été rechargé."
        )
      )
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/configuration/i)
    // Ni rechargement, ni troisième session : le script s'est arrêté et l'a dit.
    expect(run).toHaveBeenCalledTimes(3)
  })

  /**
   * Une sortie sans marqueur de fin est une session coupée en route. Conclure d'un résultat
   * partiel ferait annoncer un durcissement dont personne ne sait où il s'est arrêté.
   */
  it("ne conclut rien d'une sortie tronquée", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(ok("harden.ecrit\toui\n"))
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("failed")
    expect(r.detail).toMatch(/incomplet/)
    expect(run).toHaveBeenCalledTimes(3)
  })

  /** `restart` coupe les sessions en cours ; `reload` ne les touche pas. */
  it("recharge, ne redémarre jamais", async () => {
    const run = chaineNominale()
    await hardenSsh({ run }, target, "skynode")

    expect(run.mock.calls).toHaveLength(4)
    for (const appel of run.mock.calls) {
      expect(appel[1]).not.toMatch(/systemctl restart (ssh|sshd)/)
    }
    // Et le rechargement, lui, doit bien être là : sans lui, le test ci-dessus passerait sur
    // un module qui ne recharge rien du tout.
    expect(run.mock.calls.some((a) => /systemctl reload ssh\b/.test(String(a[1])))).toBe(true)
  })

  /** Le retour arrière recharge aussi, et pas davantage par `restart`. */
  it("ne redémarre pas non plus en défaisant", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(pose("oui"))
      .mockResolvedValueOnce(REFUS_SSH)
      .mockResolvedValueOnce(RETRAIT_OK)
      .mockResolvedValueOnce(SONDE_OK)
    await hardenSsh({ run }, target, "skynode")

    expect(run.mock.calls).toHaveLength(6)
    for (const appel of run.mock.calls) {
      expect(appel[1]).not.toMatch(/systemctl restart/)
    }
    expect(String(run.mock.calls[4]?.[1])).toMatch(/systemctl reload ssh\b/)
  })

  it("est idempotent : rejoué, il ne réécrit rien", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(INCLUS)
      .mockResolvedValueOnce(SONDE_OK)
      .mockResolvedValueOnce(pose("non"))
      .mockResolvedValueOnce(SONDE_OK)
    const r = await hardenSsh({ run }, target, "skynode")

    expect(r.outcome).toBe("unchanged")
  })

  /** La cible de la seconde session est l'utilisateur applicatif, jamais un hôte fourni. */
  it("ouvre ses sessions de vérification sur le même hôte", async () => {
    const run = chaineNominale()
    await hardenSsh({ run }, { host: "192.0.2.10", user: "root" }, "skynode")

    expect(run.mock.calls).toHaveLength(4)
    for (const appel of run.mock.calls) {
      expect(appel[0].host).toBe("192.0.2.10")
    }
    // Et chacune sur le bon compte : les deux sondes en applicatif, le reste en
    // administration. Une sonde jouée en root ne prouverait rien de la porte qu'on protège.
    expect(run.mock.calls.map((a) => a[0].user)).toEqual(["root", "skynode", "root", "skynode"])
  })

  /**
   * Un nom de compte devient l'argument de `ssh -l` : `-oProxyCommand=…` glissé là
   * exécuterait une commande sur la machine du développeur.
   */
  it("refuse un nom de compte qui n'en est pas un", async () => {
    const run = vi.fn()

    await expect(hardenSsh({ run }, target, "-oProxyCommand=touch /tmp/x")).rejects.toThrow(/compte/)
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * La découverte faite sur un VPS de production : le fichier est écrit, et une directive
   * n'a pourtant pas pris effet parce qu'un fichier trié avant le nôtre porte la sienne.
   * Annoncer un durcissement que la machine n'applique pas est pire que ne rien durcir — le
   * client cesse de s'en occuper.
   */
  describe("quand un fichier du client l'emporte", () => {
    const jouer = async (): Promise<{ r: Awaited<ReturnType<typeof hardenSsh>>; run: ReturnType<typeof vi.fn> }> => {
      const run = vi
        .fn()
        .mockResolvedValueOnce(INCLUS)
        .mockResolvedValueOnce(SONDE_OK)
        .mockResolvedValueOnce(POSE_EN_CONFLIT)
        .mockResolvedValueOnce(SONDE_OK)

      return { r: await hardenSsh({ run }, target, "skynode"), run }
    }

    it("ne rend pas « applied »", async () => {
      const { r } = await jouer()

      expect(r.outcome).toBe("failed")
    })

    it("nomme la directive et le fichier qui l'emporte", async () => {
      const { r } = await jouer()

      expect(r.detail).toContain("passwordauthentication")
      expect(r.detail).toContain("/etc/ssh/sshd_config.d/00-client.conf")
    })

    /**
     * Retirer notre fichier n'y changerait rien — celui du client resterait — et emporterait
     * les deux directives qui, elles, ont bien pris.
     */
    it("laisse le fichier en place et le dit", async () => {
      const { r, run } = await jouer()

      expect(r.detail).toMatch(/laissé en place/)
      // Le retour arrière ne s'emprunte pas : quatre appels, et aucun ne porte le script de
      // retrait — que son `harden.retire` distingue des trois autres.
      expect(run.mock.calls).toHaveLength(4)
      for (const appel of run.mock.calls) {
        expect(String(appel[1])).not.toContain("harden.retire")
      }
    })
  })
})

describe("le fichier posé", () => {
  it("porte les trois directives, et le moyen de revenir en arrière", () => {
    expect(CONFIG_DURCISSEMENT.split("\n").filter((l) => l.length > 0)).toEqual([
      "# Écrit par SkyNode. Retirer ce fichier suffit à revenir en arrière.",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin prohibit-password",
    ])
  })

  /**
   * `AllowUsers` enfermerait dehors tout compte que le client utilise et que nous ne
   * connaissons pas ; un changement de port casserait ses outils sans rien apporter, et le
   * pare-feu de `host.prepare` n'ouvre de toute façon que 22.
   */
  it("ne porte rien d'autre", () => {
    expect(CONFIG_DURCISSEMENT).not.toMatch(/AllowUsers|DenyUsers|AllowGroups/)
    expect(CONFIG_DURCISSEMENT).not.toMatch(/^Port /m)
    expect(CONFIG_DURCISSEMENT).not.toMatch(/PubkeyAuthentication|AuthorizedKeysFile/)
  })

  it("est écrit dans sshd_config.d, jamais dans sshd_config", () => {
    expect(CHEMIN_DURCISSEMENT).toBe("/etc/ssh/sshd_config.d/50-skynode.conf")
  })
})

describe("les scripts", () => {
  const tous: ReadonlyArray<readonly [string, string]> = [
    ["include", SCRIPT_INCLUDE],
    ["sonde", SCRIPT_SONDE],
    ["durcit", SCRIPT_DURCIT],
    ["retrait", SCRIPT_RETRAIT],
  ]

  it.each(tous)("%s rend son marqueur de fin", (_nom, script) => {
    expect(script).toContain("harden.end")
  })

  /**
   * Le `/bin/sh` d'Ubuntu est `dash`. Ces formes-là échouent — ou changent de sens — sur le
   * serveur du client et jamais ici. `scripts/banc.sh check` fait autorité ; ce test-ci
   * garde ce qu'un motif peut garder, à chaque exécution de la suite.
   */
  it.each(tous)("%s n'emploie aucun bashisme", (_nom, script) => {
    // `(?!:)` parce que `[[:space:]]` est une classe de caractères POSIX passée à `grep`,
    // pas le `[[` de bash : la refuser interdirait des motifs parfaitement portables.
    expect(script).not.toMatch(/\[\[(?!:)/)
    expect(script).not.toMatch(/(^|[^&>])&>/m)
    expect(script).not.toMatch(/(^|[;&|{]\s*)echo\s+-e\b/m)
    expect(script).not.toMatch(/(^[ \t]*|[;&|{][ \t]*)local\s/m)
  })

  /**
   * `restart` coupe les sessions en cours, y compris celle par laquelle ce script s'exécute.
   * Aucun des quatre ne doit en porter un, pas même le retour arrière.
   */
  it.each(tous)("%s ne redémarre aucun service", (_nom, script) => {
    expect(script).not.toMatch(/systemctl restart/)
  })

  /**
   * L'invariant n°2 : le fichier principal du client n'est **jamais** écrit. Il est lu — pour
   * l'`Include` et pour désigner le fichier qui l'emporte — et rien d'autre.
   */
  it.each(tous)("%s n'écrit jamais dans /etc/ssh/sshd_config", (_nom, script) => {
    expect(script).not.toMatch(/(?:>|>>|install |rm -f |sed -i|tee )\s*\/etc\/ssh\/sshd_config(?![.\w-])/)
  })

  describe("le script qui durcit", () => {
    /** `sshd -t` juge avant le rechargement : c'est la fenêtre où une faute se retire sans frais. */
    it("teste la configuration avant de recharger", () => {
      expect(SCRIPT_DURCIT.indexOf('"$sshd_bin" -t')).toBeGreaterThan(-1)
      expect(SCRIPT_DURCIT.indexOf('"$sshd_bin" -t')).toBeLessThan(SCRIPT_DURCIT.indexOf("if recharger; then"))
    })

    /** Une configuration refusée par `sshd -t` doit disparaître, pas rester en dormance. */
    it("retire le fichier qu'il vient d'écrire si sshd -t le refuse", () => {
      const bloc = SCRIPT_DURCIT.slice(SCRIPT_DURCIT.indexOf('if ! "$sshd_bin" -t'))

      expect(bloc.indexOf(`rm -f ${CHEMIN_DURCISSEMENT}`)).toBeGreaterThan(-1)
      expect(bloc.indexOf(`rm -f ${CHEMIN_DURCISSEMENT}`)).toBeLessThan(bloc.indexOf("il a été retiré et le "))
    })

    /**
     * Le brouillon est relu avant d'être installé : un `sshd_config` tronqué reste un
     * `sshd_config` valide, et durcirait à moitié sans que rien ne le signale.
     */
    it("relit son brouillon avant de l'installer", () => {
      expect(SCRIPT_DURCIT).toMatch(/wc -c </)
      expect(SCRIPT_DURCIT).toMatch(/Écriture interrompue/)
    })

    /** L'idempotence : sans la comparaison, chaque passage réécrirait et rendrait `applied`. */
    it("ne réécrit pas un fichier déjà identique", () => {
      expect(SCRIPT_DURCIT).toMatch(/cmp -s /)
      expect(SCRIPT_DURCIT).toMatch(/ecrit=non/)
    })

    /** Ce que le rechargement ne doit jamais faire, sur les trois formes rencontrées. */
    it("recharge le service, ou constate l'activation par socket", () => {
      expect(SCRIPT_DURCIT).toContain("systemctl reload ssh ")
      expect(SCRIPT_DURCIT).toContain("systemctl reload sshd ")
      expect(SCRIPT_DURCIT).toContain("systemctl is-active ssh.socket")
    })

    /** La découverte de production : on relit l'état résolu, on ne suppose pas. */
    it("relit l'état résolu du démon pour les trois directives", () => {
      expect(SCRIPT_DURCIT).toMatch(/"\$sshd_bin" -T/)
      for (const motCle of ["passwordauthentication", "kbdinteractiveauthentication", "permitrootlogin"]) {
        expect(SCRIPT_DURCIT).toContain(`awk -v cle='${motCle}'`)
      }
    })

    /**
     * **Régression pincée ici.** Le mot-clé était d'abord posé dans le programme `awk`, qui
     * voyage entre guillemets simples : le `shellQuote` du mot-clé refermait cette citation,
     * et `passwordauthentication` devenait une variable `awk` vide. `$1 == ""` ne
     * correspondait à rien, et le durcissement annonçait un conflit sur les trois directives
     * de **toutes** les machines. Le script passait `dash -n` sans broncher.
     */
    it("passe le mot-clé à awk par -v, jamais dans le programme", () => {
      expect(SCRIPT_DURCIT).not.toMatch(/awk '\$1 == '/)
    })

    /**
     * `sshd -T` ne rend pas la valeur écrite : pour `prohibit-password` il rend l'ancien
     * alias `without-password`. N'accepter que la valeur écrite ferait annoncer un conflit
     * inexistant sur toutes les machines.
     */
    it("accepte les deux écritures de PermitRootLogin que sshd -T peut rendre", () => {
      expect(SCRIPT_DURCIT).toContain("'prohibit-password'")
      expect(SCRIPT_DURCIT).toContain("'without-password'")
    })

    /** Le fichier qui l'emporte est cherché sans se compter lui-même. */
    it("écarte son propre fichier en cherchant celui qui l'emporte", () => {
      expect(SCRIPT_DURCIT).toContain(`grep -v -F -x '${CHEMIN_DURCISSEMENT}'`)
    })
  })

  /**
   * Ce que `sshd -T` doit rendre pour que le durcissement soit dit appliqué. Une mutation
   * a montré qu'ajouter `yes` aux valeurs acceptées de `passwordauthentication` ne tuait
   * aucun test : le produit aurait alors annoncé `applied` sur une machine dont le mot de
   * passe reste ouvert, ce que toute cette conception vise précisément à empêcher.
   */
  describe("les valeurs attendues de sshd -T", () => {
    it("n'accepte que le refus pour les deux authentifications", () => {
      const comparaisons = SCRIPT_DURCIT.split("\n").filter((l) => l.includes('"$valeur" ='))

      expect(comparaisons).toHaveLength(3)
      expect(comparaisons[0]).toBe(`if [ "$valeur" = 'no' ]; then`)
      expect(comparaisons[1]).toBe(`if [ "$valeur" = 'no' ]; then`)
      // Aucune valeur attendue n'est `yes` : la seule apparition possible serait un
      // élargissement de la table, qui ferait dire « appliqué » sur une porte restée ouverte.
      expect(SCRIPT_DURCIT).not.toContain(`'yes'`)
    })

    /**
     * `sshd -T` rend l'ancien alias : un fichier portant `prohibit-password` se relit
     * `without-password`. N'accepter que la valeur écrite ferait annoncer un conflit sur
     * toutes les machines — crier au loup sur la vérification qui justifie tout le reste.
     */
    it("accepte les deux écritures de la restriction de root", () => {
      expect(SCRIPT_DURCIT).toContain("'prohibit-password'")
      expect(SCRIPT_DURCIT).toContain("'without-password'")
    })
  })

  describe("le script de retrait", () => {
    it("retire le fichier et recharge", () => {
      expect(SCRIPT_RETRAIT).toContain(`rm -f ${CHEMIN_DURCISSEMENT}`)
      expect(SCRIPT_RETRAIT).toContain("systemctl reload ssh ")
    })

    /** Un seul fichier à retirer : c'est toute la raison de ne pas toucher à `sshd_config`. */
    it("ne retire rien d'autre", () => {
      expect([...SCRIPT_RETRAIT.matchAll(/rm -f /g)]).toHaveLength(1)
    })

    /**
     * Le `|| echec` n'est pas décoratif : `rm -f` rend 1 sur un fichier immuable, cas
     * mesuré sur le banc. Sans cette garde, le retour arrière annoncerait avoir défait un
     * durcissement toujours en place — et le client, croyant sa machine revenue à l'état
     * d'avant, n'irait pas voir.
     */
    it("échoue si le retrait n'a pas pu avoir lieu", () => {
      const ligne = SCRIPT_RETRAIT.split("\n").find((l) => l.startsWith("rm -f "))

      expect(ligne).toBeDefined()
      expect(ligne).toMatch(/^rm -f \S+ \|\| echec /)
      // `|| true &&` rendrait la garde inopérante tout en gardant les deux mots.
      expect(ligne).not.toContain("|| true")
    })
  })

  describe("la sonde applicative", () => {
    /** `sudo -n true` n'exécute que `true` : la vérification est elle-même sans effet. */
    it("constate l'élévation sans rien exécuter d'autre", () => {
      expect(SCRIPT_SONDE).toContain("sudo -n true")
      expect(SCRIPT_SONDE).not.toMatch(/rm |install |systemctl /)
    })
  })

  describe("le constat de l'Include", () => {
    it("ne prend pas une ligne commentée pour un Include", () => {
      expect(SCRIPT_INCLUDE).toContain("^[[:space:]]*include[[:space:]]")
    })

    /** Il ne fait que lire : le point 1 précède toute écriture. */
    it("n'écrit rien", () => {
      expect(SCRIPT_INCLUDE).not.toMatch(/rm |install |cat >|systemctl /)
    })
  })
})
