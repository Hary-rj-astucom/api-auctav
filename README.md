# 🐎 LeTrot API — Node.js Scraper

API Node.js qui scrape [letrot.com](https://www.letrot.com) pour reconstituer les 3 endpoints de ton CRM AUCTAV.

## Installation

```bash
npm install
node index.js
```

Serveur démarré sur `http://localhost:3000`

---

## Endpoints

### `GET /api/partants?date=YYYY-MM-DD`
**Équivalent de `getDataEquidia.php`**

Retourne tous les partants du jour avec origines complètes.

```json
[
  {
    "nom": "MISS DE BAILLE",
    "naissance": "2022",
    "sexe": "F",
    "pere": "SINGALO",
    "mere": "EPONA",
    "discipline": "Monté",
    "date": "2026-05-22",
    "course": "R7500C1",
    "prix": "PRIX OCEANA",
    "hippodrome": "VINCENNES",
    "distance": "2175",
    "record": "1'15\"0",
    "gains": "29000",
    "reduction": "1'11\"6",
    "reduction_date": "25/07/2025",
    "reduction_lieu": "GROSBOIS",
    "urlPerfs": "https://www.letrot.com/stats/chevaux/miss-de-baille/ZmBbYgAJAgUe/courses"
  }
]
```

---

### `GET /api/partantsRP?date=YYYY-MM-DD`
**Équivalent de `partantsRP.json` (iazone.fr)**

Retourne les partants trot (Attelé + Monté) du jour + demain, indexés par `nom + naissance + mere`.

```json
[
  {
    "nom": "MISS DE BAILLE",
    "naissance": "2022",
    "mere": "EPONA",
    "date": "2026-05-22",
    "prix": "PRIX OCEANA",
    "hippodrome": "VINCENNES",
    "discipline": "Monté",
    "urlPerfs": "https://www.letrot.com/stats/chevaux/..."
  }
]
```

---

### `GET /api/engages?date=YYYY-MM-DD`
**Équivalent de `getEngages.php`**

Retourne les qualifications du jour, groupées par date.

```json
{
  "2026-05-22": [
    {
      "nom": "MISS DE BAILLE",
      "naissance": "2022",
      "date": "2026-05-22",
      "hippodrome": "GROSBOIS",
      "lot": "1",
      "reduction": "1'11\"6",
      "reduction_date": "25/07/2025",
      "discipline": "Monté",
      "urlPerfs": "https://www.letrot.com/stats/chevaux/..."
    }
  ]
}
```

---

### `GET /api/programme?date=YYYY-MM-DD`
Liste des réunions + courses du jour.

```json
[
  {
    "reunion_id": "7500",
    "hippodrome": "VINCENNES",
    "date": "2026-05-22",
    "heure": "15:35",
    "courses": [
      { "num": "1", "heure": "15:57", "url": "/courses/2026-05-22/7500/1" }
    ]
  }
]
```

---

### `GET /api/cheval/:slug/:horse_id`
Fiche complète d'un cheval.

```json
{
  "nom": "MISS DE BAILLE",
  "naissance": "2022",
  "sexe": "F",
  "pere": "SINGALO",
  "mere": "EPONA",
  "gains": "29000",
  "record": "1'15\"0",
  "reduction": "1'11\"6",
  "reduction_date": "25/07/2025",
  "reduction_lieu": "GROSBOIS",
  "discipline_qualif": "monté"
}
```

---

## Cache

| Endpoint       | Durée de cache          |
|----------------|------------------------|
| `/api/partants`    | Jusqu'à minuit      |
| `/api/partantsRP`  | Jusqu'à minuit      |
| `/api/engages`     | 1 heure             |
| `/api/programme`   | Jusqu'à minuit      |
| `/api/cheval`      | 24 heures           |
| `/api/horseperf`   | get perf hors       |

Le cache est double : **mémoire (node-cache)** + **fichiers JSON** dans `/cache/`.
Au redémarrage, le cache fichier est relu automatiquement.

---

## Paramètres de date acceptés

| Valeur          | Description     |
|-----------------|-----------------|
| `aujourd-hui`   | Aujourd'hui (défaut) |
| `demain`        | Demain          |
| `hier`          | Hier            |
| `YYYY-MM-DD`    | Date précise    |

---

## Correspondance avec le PHP original

| PHP original             | Node.js équivalent         |
|--------------------------|---------------------------|
| `getDataEquidia.php`     | `GET /api/partants`       |
| `partantsRP.json` (iazone.fr) | `GET /api/partantsRP` |
| `getEngages.php`         | `GET /api/engages`        |
| `api/partants.json`      | Cache `/cache/partants_*.json` |

---

## Variables d'environnement

```env
PORT=3000   # Port du serveur (défaut: 3000)
```

## Background executable
A partir de la racine 
`node .\executable\partant.js`
`node .\executable\partantRp.js`
`node .\executable\engage.js`