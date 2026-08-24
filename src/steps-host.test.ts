import { describe, expect, it } from "vitest"

import type { PlanStep } from "./plan-types.js"
import type { StepContext } from "./step.js"
import { recipeFor, verifieConformiteScript } from "./step.js"
import {
  CONFIG_FAIL2BAN,
  CONFIG_UNATTENDED,
  EMPREINTE_CLE_DOCKER,
  PORTS_ENTRANTS,
  UTILISATEUR_APPLICATIF,
} from "./steps-host.js"

const ctx: StepContext = {
  application: "boutique",
  projectRoot: "/home/dev/boutique",
  workDir: "/opt/skynode/work/boutique",
}

/** Les deux seules étapes que ce module sait produire, avec des valeurs que Zod accepte. */
const prepare = (swapMo: number): PlanStep => ({ type: "host.prepare", swap_mo: swapMo })
const docker: PlanStep = { type: "host.install_docker" }

const scriptPrepare = (swapMo: number): string => recipeFor("host.prepare").script(prepare(swapMo), ctx)
const scriptDocker = (): string => recipeFor("host.install_docker").script(docker, ctx)

/**
 * Chaque occurrence d'`apt-get`, avec ce qui la précède immédiatement. Sert à vérifier que
 * **toutes** portent `DEBIAN_FRONTEND=noninteractive` — en compter une seule ne prouverait
 * rien : c'est celle qu'on oublie qui bloque la session jusqu'au délai.
 */
function invocationsApt(script: string): string[] {
  const prefixe = "DEBIAN_FRONTEND=noninteractive "
  const trouvees: string[] = []

  for (const m of script.matchAll(/apt-get\b/g)) {
    const index = m.index
    trouvees.push(script.slice(Math.max(0, index - prefixe.length), index + 30))
  }

  return trouvees
}

describe("host.install_docker", () => {
  it("n'installe rien si Docker est déjà utilisable", () => {
    const s = scriptDocker()

    expect(s).toMatch(/docker info/)
    expect(s).toMatch(/unchanged/)
  })

  /**
   * `docker` présent ne dit pas que le démon répond, et un démon qui répond ne dit pas que
   * le greffon compose est là. Rendre `unchanged` sur la seule présence du binaire
   * laisserait une installation partielle que le reste du jalon ne pourrait pas utiliser.
   */
  it("exige les trois constats avant de se déclarer inchangé", () => {
    // La garde elle-même, pas le script entier : une épreuve par mutation a montré que
    // chercher « docker info » n'importe où survivait à son retrait de la garde, puisque
    // le contrôle d'après-installation en porte une seconde occurrence.
    const garde = scriptDocker()
      .split("\n")
      .find((l) => l.includes("docker_ok=oui") || l.includes("command -v docker"))

    expect(garde).toBeDefined()
    expect(garde).toContain("command -v docker")
    expect(garde).toContain("docker info")
    expect(garde).toContain("docker compose version")
  })

  /**
   * Le dépôt officiel, pas le paquet de la distribution : `docker.io` d'Ubuntu est souvent
   * en retard de plusieurs versions majeures et n'apporte pas le greffon compose.
   */
  it("installe depuis le dépôt officiel, avec la clé vérifiée", () => {
    const s = scriptDocker()

    expect(s).toContain("download.docker.com")
    expect(s).toMatch(/gpg|keyring/)
    expect(s).toContain("docker-compose-plugin")
    expect(s).toContain("signed-by=/etc/apt/keyrings/docker.asc")
  })

  it("n'emploie jamais le paquet docker.io de la distribution", () => {
    expect(scriptDocker()).not.toMatch(/\bdocker\.io\b/)
  })

  /**
   * L'empreinte est comparée **avant** que la clé atteigne `/etc/apt/keyrings/` : une clé
   * inattendue ne doit pas séjourner une seule seconde à l'endroit qu'APT consulte pour
   * authentifier des paquets installés en root.
   */
  it("compare l'empreinte de la clé avant de l'installer", () => {
    const s = scriptDocker()
    const controle = s.indexOf(EMPREINTE_CLE_DOCKER)
    const pose = s.indexOf("/etc/apt/keyrings/docker.asc || echec")

    expect(controle).toBeGreaterThan(-1)
    expect(pose).toBeGreaterThan(controle)
    expect(EMPREINTE_CLE_DOCKER).toMatch(/^[0-9A-F]{40}$/)
  })

  /** Sans cela, la première construction demande un mot de passe qui n'arrivera jamais. */
  it("ajoute l'utilisateur applicatif au groupe docker", () => {
    expect(scriptDocker()).toMatch(/usermod .*docker/)
    expect(scriptDocker()).toContain(`usermod -aG docker ${UTILISATEUR_APPLICATIF}`)
  })

  /**
   * Un `docker.list` déjà présent est celui du client, ou celui d'un passage précédent :
   * le réécrire changerait la suite ou la clé d'un dépôt que quelqu'un d'autre a choisi.
   */
  it("ne réécrit pas un fichier de dépôt déjà présent", () => {
    expect(scriptDocker()).toContain("if [ ! -f /etc/apt/sources.list.d/docker.list ]; then")
  })

  it("n'est pas réversible et le déclare", () => {
    expect(recipeFor("host.install_docker").undoScript(docker, ctx)).toBeNull()
  })

  it("refuse une étape d'un autre type", () => {
    expect(() => recipeFor("host.install_docker").script(prepare(0), ctx)).toThrow(/host\.install_docker/)
  })
})

describe("host.prepare", () => {
  it("crée l'utilisateur applicatif s'il manque, sans rien changer sinon", () => {
    const s = scriptPrepare(0)

    expect(s).toMatch(/id -u skynode/)
    expect(s).toContain("useradd")
  })

  /**
   * L'ordre compte, et l'inverse coupe la session en cours : activer UFW avant d'avoir
   * autorisé le port 22 ferme la connexion par laquelle on travaille.
   */
  it("autorise le port 22 AVANT d'activer le pare-feu", () => {
    const s = scriptPrepare(0)
    const allow = s.indexOf("ufw allow 22")
    const enable = s.indexOf("ufw --force enable")

    expect(allow).toBeGreaterThan(-1)
    expect(enable).toBeGreaterThan(allow)
  })

  /**
   * Le tableau des ports dicte l'ordre des règles. Si 22 cessait d'y être en tête, le test
   * ci-dessus continuerait de passer tant que 22 y figure, mais l'ordre réel des `ufw allow`
   * changerait : c'est cette propriété-là qu'on épingle.
   */
  it("pose la règle du port 22 en premier", () => {
    expect(PORTS_ENTRANTS[0]).toBe(22)
  })

  /**
   * Écrit sans `m[1]!` ni assertion : sous `noUncheckedIndexedAccess`, `m[1]` est
   * `string | undefined`, et un `map` direct produirait un tableau que la comparaison
   * d'ensembles ne saurait pas décrire.
   */
  it("n'ouvre que 22, 80 et 443", () => {
    const s = scriptPrepare(0)
    const ports = [...s.matchAll(/ufw allow (\d+)/g)].flatMap((m) => {
      const port = m[1]
      return port === undefined ? [] : [port]
    })

    expect(new Set(ports)).toEqual(new Set(["22", "80", "443"]))
    // Aucune autre forme d'autorisation — `ufw allow from …`, `ufw allow OpenSSH` — ne doit
    // se glisser à côté : la liste ci-dessus ne verrait pas un port ouvert sans chiffre.
    expect(s).not.toMatch(/ufw allow (?!22\/tcp|80\/tcp|443\/tcp)/)
  })

  /** L'UDP n'est écouté par rien dans ce produit ; `ufw allow 22` l'ouvrirait aussi. */
  it("n'ouvre que le TCP", () => {
    const s = scriptPrepare(0)

    for (const port of PORTS_ENTRANTS) {
      expect(s).toContain(`ufw allow ${port}/tcp`)
    }
  })

  /**
   * Le filet du point le plus important de la tâche : `ufw status` ne montre aucune règle
   * tant que le pare-feu est inactif, donc seul `ufw show added` peut confirmer, avant
   * l'activation, que le port 22 est bien enregistré. Sans ce contrôle, une règle perdue
   * en silence ferait couper la session par l'activation qui suit.
   */
  it("refuse d'activer un pare-feu dont la règle du port 22 n'est pas enregistrée", () => {
    const s = scriptPrepare(0)
    const filet = s.indexOf("ufw show added")
    const enable = s.indexOf("ufw --force enable")

    expect(filet).toBeGreaterThan(-1)
    expect(enable).toBeGreaterThan(filet)
    expect(s.slice(filet, enable)).toMatch(/allow 22\/tcp.*echec/s)
  })

  /** Le pare-feu du client n'est jamais remis à zéro : ses règles ne nous appartiennent pas. */
  it("ne réinitialise pas le pare-feu existant", () => {
    expect(scriptPrepare(0)).not.toMatch(/ufw (--force )?reset/)
  })

  it("ne crée un fichier d'échange que si le plan en demande un", () => {
    expect(scriptPrepare(0)).not.toMatch(/fallocate|swapon/)
    expect(scriptPrepare(2048)).toMatch(/fallocate|dd/)
  })

  /** Un swap déjà actif ne doit pas être remplacé : on ne touche pas à ce qui marche. */
  it("ne remplace pas un fichier d'échange existant", () => {
    const s = scriptPrepare(2048)

    expect(s).toMatch(/swapon --show|\/proc\/swaps/)
    expect(s).toContain("[ ! -e /swapfile ]")
  })

  /** La taille vient du plan, pas d'une constante : deux plans donnent deux fichiers. */
  it("crée le fichier d'échange à la taille demandée par le plan", () => {
    expect(scriptPrepare(512)).toContain("fallocate -l 512M /swapfile")
    expect(scriptPrepare(512)).toContain("count=512")
    expect(scriptPrepare(2048)).toContain("fallocate -l 2048M /swapfile")
  })

  /**
   * `/etc/fstab` est forcément à quelqu'un d'autre : bloc marqué, jamais de redirection qui
   * écraserait le fichier entier (spec §6.4).
   */
  it("n'inscrit le swap dans fstab que par un bloc marqué", () => {
    const s = scriptPrepare(2048)

    expect(s).toContain("# >>> skynode-swap >>>")
    expect(s).toContain("/swapfile none swap sw 0 0")
    expect(s).not.toMatch(/(^|[^>])>\s*'\/etc\/fstab'/m)
  })

  /**
   * Le contenu réel du fichier posé, pas l'absence d'un motif dans le script : c'est le
   * fichier qui décide de ce qu'`unattended-upgrades` installera en root sans surveillance.
   */
  it("limite unattended-upgrades aux correctifs de sécurité", () => {
    const bloc = CONFIG_UNATTENDED.match(/Unattended-Upgrade::Allowed-Origins \{([\s\S]*?)\};/)
    const corps = bloc?.[1]

    expect(corps).toBeDefined()

    const origines = [...(corps ?? "").matchAll(/"([^"]+)"/g)].flatMap((m) => {
      const origine = m[1]
      return origine === undefined ? [] : [origine]
    })

    expect(origines.length).toBeGreaterThan(0)
    for (const origine of origines) {
      expect(origine).toMatch(/-security$/)
    }
  })

  /**
   * Les listes d'APT sont additives : sans `#clear`, les origines ci-dessus s'ajouteraient
   * à celles de `50unattended-upgrades` et `-updates` resterait autorisé. Le fichier aurait
   * l'air de restreindre quelque chose sans rien restreindre.
   */
  it("vide les origines de la distribution avant de poser les siennes", () => {
    const clear = CONFIG_UNATTENDED.indexOf("#clear Unattended-Upgrade::Allowed-Origins;")
    const pose = CONFIG_UNATTENDED.indexOf("Unattended-Upgrade::Allowed-Origins {")

    expect(clear).toBeGreaterThan(-1)
    expect(pose).toBeGreaterThan(clear)
    // Debian emploie `Origins-Pattern` là où Ubuntu emploie `Allowed-Origins` : ne vider
    // que l'une laisserait l'autre en place sur la moitié des distributions visées.
    expect(CONFIG_UNATTENDED).toContain("#clear Unattended-Upgrade::Origins-Pattern;")
  })

  /** Le fichier est posé après celui de la distribution, sinon elle reprend la main. */
  it("pose son réglage après celui de la distribution", () => {
    expect(scriptPrepare(0)).toContain("/etc/apt/apt.conf.d/51skynode-securite")
  })

  /**
   * Un fichier invalide dans `sudoers.d` fait refuser **toute** élévation sur la machine,
   * y compris celle qui permettrait de le réparer. Le contrôle porte donc sur le brouillon,
   * et le fichier définitif n'est posé que si le brouillon passe.
   */
  it("fait valider la règle sudo par visudo avant de l'installer", () => {
    const s = scriptPrepare(0)
    const controle = s.indexOf("visudo -c")
    const pose = s.indexOf("/etc/sudoers.d/90-skynode' || echec")

    expect(controle).toBeGreaterThan(-1)
    expect(pose).toBeGreaterThan(controle)
    expect(s).toContain(`${UTILISATEUR_APPLICATIF} ALL=NOPASSWD: ALL`)
    // Pas de spécification d'exécutant : l'omettre restreint l'élévation à `root`, là où
    // `(ALL)` laisserait le compte applicatif devenir n'importe quel utilisateur de la
    // machine, y compris ceux du client.
    expect(s).not.toContain("ALL=(ALL)")
  })

  /** Le `/etc/sudoers` du client n'est jamais ouvert : un fichier à part se retire seul. */
  it("n'écrit pas dans /etc/sudoers", () => {
    expect(scriptPrepare(0)).not.toMatch(/>\s*'?\/etc\/sudoers'/)
  })

  it("surveille sshd avec fail2ban", () => {
    expect(CONFIG_FAIL2BAN).toContain("[sshd]")
    expect(CONFIG_FAIL2BAN).toContain("enabled = true")
    // Ubuntu 24.04 n'installe plus `rsyslog` : une prison qui lit /var/log/auth.log ne
    // démarre pas, et le service passerait pour actif sans rien surveiller.
    expect(CONFIG_FAIL2BAN).toContain("backend = systemd")
    expect(scriptPrepare(0)).toContain("/etc/fail2ban/jail.d/50-skynode.conf")
  })

  it("ferme /etc/skynode aux autres comptes", () => {
    const s = scriptPrepare(0)

    expect(s).toContain("install -d -m 0700 -o root -g root '/etc/skynode'")
    expect(s).toContain("chmod 0700 '/etc/skynode'")
  })

  /**
   * Un `authorized_keys` déjà garni est celui du client : l'écraser lui retirerait son
   * propre accès au compte applicatif. On ne pose que dans le vide.
   */
  it("n'écrase jamais une clé autorisée existante", () => {
    expect(scriptPrepare(0)).toContain('[ ! -s "$foyer/.ssh/authorized_keys" ]')
  })

  /**
   * Le durcissement SSH est la tâche 4, et il n'a pas d'à-peu-près : il est la seule
   * opération du produit dont l'échec est irréparable à distance, et il se vérifie par un
   * protocole de reconnexion que cette étape-ci n'a pas. Une directive glissée ici y
   * échapperait entièrement.
   */
  it("ne touche ni à la configuration ni au service SSH", () => {
    const s = scriptPrepare(2048)

    expect(s).not.toContain("sshd_config")
    expect(s).not.toContain("PasswordAuthentication")
    expect(s).not.toContain("PermitRootLogin")
    expect(s).not.toMatch(/systemctl (restart|reload|stop) ssh\b/)
  })

  /** On n'arrête jamais un service qu'on n'a pas créé (invariant n°2). */
  it("n'arrête aucun service", () => {
    expect(scriptPrepare(2048)).not.toMatch(/systemctl stop\b/)
  })

  it("n'est pas réversible", () => {
    expect(recipeFor("host.prepare").undoScript(prepare(0), ctx)).toBeNull()
    expect(recipeFor("host.prepare").undoScript(prepare(2048), ctx)).toBeNull()
  })

  it("refuse une étape d'un autre type", () => {
    expect(() => recipeFor("host.prepare").script(docker, ctx)).toThrow(/host\.prepare/)
  })

  /**
   * Le script tourne en root, sur une session dont rien ne garantit le répertoire courant.
   * Le nom d'origine de ce test promettait « chemins absolus » et ne vérifiait que
   * l'absence de `cd` — ce qu'il cherche vraiment, c'est qu'aucune cible ne se résolve
   * relativement à quoi que ce soit d'hérité de l'appelant.
   */
  it("ne dépend ni du répertoire courant ni de l'environnement de l'appelant", () => {
    const s = scriptPrepare(2048)

    expect(s).not.toMatch(/^\s*cd\s/m)
    expect(s).not.toContain("$PWD")
    expect(s).not.toContain("$HOME")
    expect(s).not.toContain("$OLDPWD")
    // Aucun argument relatif : ni `./x`, ni `../x`, ni `~/x`.
    expect(s).not.toMatch(/(^|\s)\.{1,2}\//m)
    expect(s).not.toMatch(/(^|\s)~\//m)
    // Les cibles d'écriture sont toutes nommées en toutes lettres depuis la racine.
    for (const chemin of [
      "/etc/skynode",
      "/etc/sudoers.d/90-skynode",
      "/etc/fail2ban/jail.d/50-skynode.conf",
      "/etc/apt/apt.conf.d/51skynode-securite",
      "/swapfile",
    ]) {
      expect(s).toContain(chemin)
    }
  })
})

describe("les deux étapes", () => {
  const scripts: ReadonlyArray<readonly [string, string]> = [
    ["host.install_docker", scriptDocker()],
    ["host.prepare (sans échange)", scriptPrepare(0)],
    ["host.prepare (avec échange)", scriptPrepare(2048)],
  ]

  /**
   * Une invite de `dpkg` attend une réponse qui n'arrivera jamais et bloque la session
   * jusqu'au délai. En compter une seule ne prouverait rien : c'est celle qu'on oublie qui
   * fait le mal, d'où le passage sur **toutes** les occurrences.
   */
  it.each(scripts)("%s n'invoque apt-get qu'en mode non interactif", (_nom, s) => {
    const invocations = invocationsApt(s)

    expect(invocations.length).toBeGreaterThan(0)
    for (const invocation of invocations) {
      expect(invocation).toContain("DEBIAN_FRONTEND=noninteractive apt-get")
    }
  })

  /**
   * `stdout` porte le protocole d'étape que `runRemote` analyse. Un outil bavard qui y
   * écrit directement — `apt-get`, `ufw`, `systemctl` en écrivent tous — noierait
   * `step.outcome` au milieu de deux cents lignes de `dpkg`, et une ligne de paquet portant
   * une tabulation suffirait à égarer l'analyseur.
   */
  it.each(scripts)("%s ne laisse aucun outil bavard écrire sur stdout", (_nom, s) => {
    const bavards = /^(?!\s*#).*\b(apt-get|ufw (allow|default|--force enable)|systemctl (enable|reload))\b/

    for (const ligne of s.split("\n")) {
      if (!bavards.test(ligne)) continue
      // Soit la sortie est détournée, soit la ligne n'est qu'un test dans une condition.
      expect(ligne).toMatch(/>&2|>\s*\/dev\/null|\|\s*grep/)
    }
  })

  /** On installe ce qu'on a annoncé au client, rien d'autre. */
  it.each(scripts)("%s ne met jamais la machine à jour de son propre chef", (_nom, s) => {
    expect(s).not.toMatch(/apt-get\s+(-\S+\s+)*(dist-)?upgrade/)
  })

  /** Sans droits, le script laisserait la machine à moitié préparée en croyant avoir agi. */
  it.each(scripts)("%s refuse de s'exécuter hors root", (_nom, s) => {
    expect(s).toContain('if [ "$(id -u)" != 0 ]; then')
  })

  /** Le protocole de `runRemote` : un résultat, un détail, un marqueur de fin. */
  it.each(scripts)("%s rend le protocole d'étape", (_nom, s) => {
    expect(s).toContain("step.outcome")
    expect(s).toContain("step.detail")
    expect(s).toContain("step.end")
    expect(s).toContain("unchanged")
  })

  /**
   * Le harnais de `step.ts` sur les deux variantes de `host.prepare` : celui de
   * `step.test.ts` n'éprouve qu'une étape par type, et c'est la présence ou l'absence du
   * fichier d'échange qui fait ici deux scripts différents.
   */
  it("les deux variantes de host.prepare passent les quatre contrôles", () => {
    expect(() => verifieConformiteScript("host.prepare", prepare(0), ctx)).not.toThrow()
    expect(() => verifieConformiteScript("host.prepare", prepare(2048), ctx)).not.toThrow()
  })

  it("host.install_docker passe les quatre contrôles", () => {
    expect(() => verifieConformiteScript("host.install_docker", docker, ctx)).not.toThrow()
  })
})
