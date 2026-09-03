import { describe, expect, it } from "vitest"

import { ALLOWED_NETWORK } from "./plan-rules.js"
import {
  LIGNES_DEFAUT,
  LIGNES_MAX,
  MARQUEUR_ABSENT,
  MARQUEUR_LOGS,
  bornerLignes,
  exigeSince,
  scriptLogs,
  scriptRollback,
} from "./ops.js"
import { ETIQUETTE_APP, cheminEnv } from "./steps-app.js"
import { ETIQUETTE_PORT } from "./steps-proxy.js"

describe("bornerLignes", () => {
  /** Des journaux entiers noieraient le contexte de l'agent et lui feraient perdre le fil. */
  it("plafonne, quoi qu'on demande", () => {
    expect(bornerLignes(999_999)).toBe(LIGNES_MAX)
    expect(bornerLignes(Number.POSITIVE_INFINITY)).toBe(LIGNES_DEFAUT)
  })

  it("retombe sur le défaut quand rien n'est demandé", () => {
    expect(bornerLignes(undefined)).toBe(LIGNES_DEFAUT)
    expect(bornerLignes(Number.NaN)).toBe(LIGNES_DEFAUT)
  })

  /** Zéro ligne rendrait un journal vide qui se lirait comme une application silencieuse. */
  it("ne descend jamais sous une ligne", () => {
    expect(bornerLignes(0)).toBe(1)
    expect(bornerLignes(-50)).toBe(1)
  })

  it("arrondit vers le bas plutôt que de laisser passer un décimal", () => {
    expect(bornerLignes(10.9)).toBe(10)
  })
})

describe("exigeSince", () => {
  it.each(["2026-01-31T09:00:00Z", "2026-01-31", "2026-01-31T09:00:00.123+01:00", "30m", "2h", "1h30m", "7d"])(
    "accepte %s",
    (valeur) => {
      expect(exigeSince(valeur)).toBe(valeur)
    }
  )

  /**
   * Cette valeur vient de l'agent et entre dans une ligne de commande jouée en root : le
   * motif est le contrôle qui autorise son interpolation.
   */
  it.each(["; rm -rf /", "$(whoami)", "`id`", "30m; touch /tmp/x", "--tail 5", "'", "hier"])(
    "refuse %s",
    (valeur) => {
      expect(() => exigeSince(valeur)).toThrow()
    }
  )
})

describe("scriptLogs", () => {
  it("plafonne à mille lignes même si l'agent en demande davantage", () => {
    const s = scriptLogs("boutique", 999_999)

    expect(s).toContain(`--tail ${LIGNES_MAX}`)
    expect(s).not.toContain("999999")
  })

  /**
   * `2>&1` n'est pas cosmétique : une application qui écrit ses erreurs sur la sortie
   * d'erreur — la plupart — ne montrerait rien de ce qui explique une panne sans lui.
   */
  it("mêle la sortie d'erreur à la sortie standard", () => {
    // Sur la ligne de `docker logs`, pas ailleurs : le script porte d'autres `2>&1` qui ne
    // disent rien de ce contrôle-ci.
    const ligne = scriptLogs("boutique", 100)
      .split("\n")
      .find((l) => l.startsWith("docker logs"))

    expect(ligne).toContain("2>&1")
  })

  /** Un journal sans dates ne permet pas de rattacher une erreur à un déploiement. */
  it("horodate", () => {
    expect(scriptLogs("boutique", 100)).toContain("--timestamps")
  })

  /**
   * Un conteneur absent doit se distinguer d'un conteneur muet : l'agent lirait le second
   * comme un fonctionnement normal.
   */
  it("distingue l'absence du silence", () => {
    expect(scriptLogs("boutique", 100)).toContain(MARQUEUR_ABSENT)
    expect(scriptLogs("boutique", 100)).toContain(MARQUEUR_LOGS)
  })

  it("n'ajoute --since que lorsqu'il y en a un", () => {
    expect(scriptLogs("boutique", 100)).not.toContain("--since")
    expect(scriptLogs("boutique", 100, "30m")).toContain("--since '30m'")
  })

  it.each(["../evasion", "Boutique", "a b", "boutique; rm -rf /"])(
    "refuse un nom d'application hostile : %s",
    (nom) => {
      expect(() => scriptLogs(nom, 100)).toThrow()
    }
  )

  /** Lire n'écrit pas : aucune commande de ce script ne change quoi que ce soit. */
  it("n'exécute aucune commande qui modifie la machine", () => {
    const s = scriptLogs("boutique", 100)

    expect(s).not.toMatch(/docker (run|rm|rmi|stop|start|exec|build|pull)\b/)
    expect(s).not.toMatch(/\brm\b|\bmv\b|\bchmod\b|\bchown\b|\bmkdir\b|\binstall\b/)
    // `>/dev/null` n'écrit nulle part ; toute autre redirection vers un fichier, si.
    expect(s.replace(/>\s*\/dev\/null/g, "")).not.toMatch(/>\s*\//)
  })
})

describe("scriptRollback", () => {
  const s = (): string => scriptRollback("boutique")

  /** Invariant n°2 : un conteneur qui n'est pas le nôtre n'est jamais remplacé. */
  it("refuse un conteneur qui ne porte pas notre étiquette", () => {
    expect(s()).toContain(`{{index .Config.Labels "${ETIQUETTE_APP}"}}`)
    expect(s()).toMatch(/if \[ "\$proprietaire" != 'boutique' \]; then\n\s*echec/)
  })

  /**
   * Revenir à une image qui n'existe pas laisserait l'application arrêtée, sans rien pour
   * la remplacer — pire que ne pas revenir du tout. Le refus vient donc **avant** l'arrêt.
   */
  it("refuse sans rien toucher quand il n'y a pas de version précédente", () => {
    const texte = s()

    expect(texte).toMatch(/if \[ -z "\$precedente" \]; then\n\s*echec/)
    expect(texte.indexOf('if [ -z "$precedente" ]')).toBeLessThan(texte.indexOf("docker rm -f boutique"))
  })

  /**
   * Deux étiquettes d'une même image ne sont pas deux versions : y « revenir » ne changerait
   * rien tout en coupant le service le temps du redémarrage.
   */
  it("écarte une étiquette qui désigne l'image déjà en service", () => {
    const texte = s()

    expect(texte).toContain('if [ "$etiquette" = "$courante" ]; then continue; fi')
    expect(texte).toContain('case "$identifiant" in *"$id"*) continue ;; esac')
  })

  /** Sans l'étiquette de port, le proxy perdrait ce qui lui dit où router. */
  it("refuse un conteneur sans étiquette de port exploitable", () => {
    expect(s()).toContain(`{{index .Config.Labels "${ETIQUETTE_PORT}"}}`)
    expect(s()).toMatch(/""\|0\*\|\*\[!0-9\]\*\) echec/)
  })

  /** Le conteneur ramené porte les mêmes étiquettes : sinon rollback casserait le routage. */
  it("repose les deux étiquettes et le même réseau", () => {
    const texte = s()

    expect(texte).toContain(`--label '${ETIQUETTE_APP}=boutique'`)
    expect(texte).toContain(`--label ${ETIQUETTE_PORT}="$port"`)
    expect(texte).toContain(`--network ${ALLOWED_NETWORK}`)
    expect(texte).toContain("--restart unless-stopped")
    expect(texte).not.toMatch(/-p \d+:|--publish/)
  })

  it("recharge le fichier d'environnement s'il existe", () => {
    expect(s()).toContain(`if [ -f '${cheminEnv("boutique")}' ]; then`)
  })

  /**
   * Le filet qui compte : un retour arrière qui laisse l'application éteinte est le seul
   * résultat pire que le déploiement qu'il essayait de corriger.
   */
  it("remet la version en service si la précédente ne tient pas debout", () => {
    const texte = s()

    expect(texte).toContain('if lance "$precedente" && tient; then')
    expect(texte).toContain('if lance "$courante" && tient; then')
    expect(texte.indexOf('lance "$precedente"')).toBeLessThan(texte.indexOf('lance "$courante"'))
    expect(texte).toMatch(/version qui tournait a été remise en service/)
  })

  /** Et si rien ne tient, le dire, plutôt que de laisser croire à un retour réussi. */
  it("dit que l'application est arrêtée quand rien ne tient", () => {
    expect(s()).toMatch(/Ni la version précédente ni celle qui tournait/)
  })

  /**
   * `.State.Status`, jamais `.State.Running` : un conteneur en boucle de redémarrage rend
   * `Running=true`, et le retour arrière se croirait abouti.
   */
  it("juge la vivacité sur le statut et le compte de redémarrages", () => {
    const texte = s()

    expect(texte).toContain("{{.State.Status}}")
    expect(texte).toContain("{{.RestartCount}}")
    expect(texte).not.toContain("{{.State.Running}}")
  })

  /** L'élagage de `build.image` conserve trois images : rollback ne sort pas de ce dépôt. */
  it("ne cherche que dans le dépôt de cette application", () => {
    expect(s()).toContain("docker images 'skynode/boutique'")
    expect(s()).not.toMatch(/image prune|system prune/)
  })

  it.each(["../evasion", "Boutique", "a b"])("refuse un nom d'application hostile : %s", (nom) => {
    expect(() => scriptRollback(nom)).toThrow()
  })
})
