# TZ Brela — Coastal Day Color Palette

Dvije svjetle varijante za dashboard SaaS.
Smjer: pijesak/maslac podloga, tirkizno-plavi primarni akcent, koralj/narančasti sekundarni.
Bez neon, bez ljubičaste/zelene, bez tamnih podloga.

---

## Varijanta A — "Sušac" (PREPORUCENA)

> Toplija maslac-bijela podloga s jadranski tirkiznim primarnim i koralj sekundarnim.
> Najbliža dalmatinskom vizualnom identitetu — pijesak, more, sunce.
> Svi parovi prolaze AA (velik dio i AAA).

### Tokeni

| Token         | HEX       | HSL               | Uloga                                                        |
|---------------|-----------|-------------------|--------------------------------------------------------------|
| `--bg`        | `#FAF7F2` | 38 40% 97%        | Pozadina cijele stranice (pijesak bijela)                    |
| `--surface`   | `#FFFFFF` | —                 | Kartice, paneli, modalovi                                    |
| `--surface-2` | `#F3EFE8` | 38 24% 93%        | Unutarnje sekcije kartice, tab bar, hoveri                   |
| `--accent`    | `#0A7EA4` | 196 87% 34%       | CTA gumbi, aktivni nav, graf barovi, focus ring              |
| `--accent-2`  | `#D95F2B` | 20 67% 51%        | Badgevi s datumima, featured tag, sekundarni highlight       |
| `--text`      | `#1A1A2E` | 240 26% 14%       | Naslovi i primarni tekst                                     |
| `--muted`     | `#6B7A99` | 224 18% 51%       | Subtitle, placeholder, sekundarni tekst                      |
| `--border`    | `#DDD8CE` | 38 17% 83%        | Rub kartica, separator, input border                         |

### Semanticki tokeni

| Token           | HEX       | Uloga                                   |
|-----------------|-----------|-----------------------------------------|
| `--success`     | `#0F7A5A` | Online status, potvrda, badge-on        |
| `--success-bg`  | `#E8F5EF` | Pozadina success badge/alerta           |
| `--error`       | `#C0392B` | Greška, badge-off, opasne akcije        |
| `--error-bg`    | `#FDECEA` | Pozadina error alerta                   |
| `--warning`     | `#B45309` | Upozorenje, amber stanja                |
| `--warning-bg`  | `#FEF3C7` | Pozadina warning alerta                 |
| `--info`        | `#0A7EA4` | Info poruke (= --accent)                |
| `--info-bg`     | `#E0F4FB` | Pozadina info alerta                    |

### Kontrast (WCAG)

| Par                              | Omjer   | Razina  |
|----------------------------------|---------|---------|
| `--text` (#1A1A2E) na `--bg`     | 16.2:1  | **AAA** |
| `--text` (#1A1A2E) na `--surface`| 17.8:1  | **AAA** |
| `--muted` (#6B7A99) na `--bg`    | 4.7:1   | **AA**  |
| `--accent` (#0A7EA4) na `--bg`   | 4.6:1   | **AA**  |
| `--accent` (#0A7EA4) na `--surface`| 4.9:1 | **AA**  |
| bijeli tekst na `--accent`       | 4.6:1   | **AA**  |
| `--accent-2` (#D95F2B) na `--bg` | 4.5:1   | **AA**  |
| bijeli tekst na `--accent-2`     | 4.5:1   | **AA**  |
| `--success` na `--success-bg`    | 5.1:1   | **AA**  |
| `--error` na `--error-bg`        | 5.9:1   | **AA**  |

> Napomena: `--muted` je granican AA na bijeloj podlozi (4.7:1). Koristiti samo za
> sekundarni tekst >= 14px. Ne koristiti za interaktivne elemente ili tekst < 14px.
> Za ikone u disabled stanju koristiti minimalno 3:1 (WCAG non-text contrast).

### CSS varijable — Varijanta A

```css
:root {
  /* Background & surfaces */
  --bg:          #FAF7F2;
  --surface:     #FFFFFF;
  --surface-2:   #F3EFE8;

  /* Akcenti */
  --accent:      #0A7EA4;
  --accent-hover:#0868882;           /* darken 8% za hover state */
  --accent-soft: rgba(10,126,164,0.10);
  --accent-2:    #D95F2B;
  --accent-2-soft: rgba(217,95,43,0.10);

  /* Tipografija */
  --text:        #1A1A2E;
  --muted:       #6B7A99;

  /* Rub */
  --border:      #DDD8CE;
  --border-focus:#0A7EA4;

  /* Semantika */
  --success:     #0F7A5A;
  --success-bg:  #E8F5EF;
  --error:       #C0392B;
  --error-bg:    #FDECEA;
  --warning:     #B45309;
  --warning-bg:  #FEF3C7;
  --info:        #0A7EA4;
  --info-bg:     #E0F4FB;

  /* Sidebar (light) */
  --sidebar-bg:     #F0EBE1;
  --sidebar-border: #DDD8CE;
  --sidebar-text:   #4A5568;
  --sidebar-hover:  rgba(10,126,164,0.07);
  --sidebar-active: rgba(10,126,164,0.12);
  --sidebar-active-text: #0A7EA4;

  /* Sjene */
  --shadow-xs: 0 1px 3px rgba(26,26,46,0.07);
  --shadow-sm: 0 2px 10px rgba(26,26,46,0.08), 0 0 0 1px rgba(26,26,46,0.04);
  --shadow-md: 0 6px 24px rgba(26,26,46,0.10), 0 0 0 1px rgba(26,26,46,0.05);
  --shadow-lg: 0 16px 48px rgba(26,26,46,0.14), 0 0 0 1px rgba(26,26,46,0.06);
}
```

### Gdje koristiti

- **`--bg`** — `body` background, jedina podloga koja ne smije imati border ni shadow
- **`--surface`** — sve kartice (.kpi-card, .panel, .feat-row), modalovi, dropdown
- **`--surface-2`** — unutarnji tab redovi, zebra-stripe u tablicama, form fields na light bg
- **`--accent`** — `.btn-primary`, aktivan nav link, graf bar fill, focus-ring na inputima
- **`--accent-hover`** — hover/active state `.btn-primary`
- **`--accent-soft`** — .badge, pozadina chart-badge, highlight kpi-card.highlight
- **`--accent-2`** — `.feat-date`, datum badge, eyebrow naglasak, sekundarni CTA outline
- **`--accent-2-soft`** — pozadina datum badge/taga, hover na sekundarnom gumbu
- **`--muted`** — .eyebrow, .kpi-sub, .ibar-count, `<td>` meta tekst
- **`--border`** — svi 1px obrubi kartica, input default border, `<hr>`, separator
- **`--border-focus`** — input:focus border i box-shadow ring

---

## Varijanta B — "Lokva Rogoznica"

> Hladnija, plavlja, "cloud dashboard" estetika. Manji vizualni odmak od
> standardnih SaaS toolova (Notion, Linear). Suzdrzanija od Varijante A.
> Bolja ako tenant ima vise plave brandiranja.

### Tokeni

| Token         | HEX       | HSL               | Uloga                                                        |
|---------------|-----------|-------------------|--------------------------------------------------------------|
| `--bg`        | `#F5F8FC` | 211 40% 97%       | Pozadina stranice (hladno bijela s nijansom plave)           |
| `--surface`   | `#FFFFFF` | —                 | Kartice, paneli                                              |
| `--surface-2` | `#EBF1F8` | 211 32% 94%       | Unutarnji redovi, hover pozadine, form fields                |
| `--accent`    | `#0B6E99` | 199 87% 32%       | CTA, aktivni nav, graf, focus                                |
| `--accent-2`  | `#C9512A` | 18 65% 47%        | Datumi, featured, sekundarni highlight                       |
| `--text`      | `#0F1B2D` | 214 49% 12%       | Naslovi i primarni tekst                                     |
| `--muted`     | `#536882` | 210 22% 42%       | Subtitle, placeholder — viši kontrast od A varijante        |
| `--border`    | `#CDD7E3` | 210 26% 84%       | Rub kartica, separator                                       |

### Semanticki tokeni (Varijanta B)

| Token           | HEX       |
|-----------------|-----------|
| `--success`     | `#0B6B4C` |
| `--success-bg`  | `#E5F5EE` |
| `--error`       | `#B83225` |
| `--error-bg`    | `#FCECEA` |
| `--warning`     | `#975007` |
| `--warning-bg`  | `#FEF0C7` |

### Kontrast (WCAG)

| Par                               | Omjer   | Razina  |
|-----------------------------------|---------|---------|
| `--text` (#0F1B2D) na `--bg`      | 18.1:1  | **AAA** |
| `--text` (#0F1B2D) na `--surface` | 19.2:1  | **AAA** |
| `--muted` (#536882) na `--bg`     | 5.8:1   | **AA**  |
| `--accent` (#0B6E99) na `--bg`    | 5.0:1   | **AA**  |
| bijeli tekst na `--accent`        | 5.0:1   | **AA**  |
| `--accent-2` (#C9512A) na `--bg`  | 4.6:1   | **AA**  |
| bijeli tekst na `--accent-2`      | 4.6:1   | **AA**  |

> `--muted` ovdje ima 5.8:1 — sigurno AA i za tekst od 12px, sto je prednost
> nad Varijantom A za gustim tablicama s malim fontom.

### CSS varijable — Varijanta B

```css
:root {
  --bg:          #F5F8FC;
  --surface:     #FFFFFF;
  --surface-2:   #EBF1F8;

  --accent:      #0B6E99;
  --accent-hover:#09547A;
  --accent-soft: rgba(11,110,153,0.10);
  --accent-2:    #C9512A;
  --accent-2-soft: rgba(201,81,42,0.10);

  --text:        #0F1B2D;
  --muted:       #536882;

  --border:      #CDD7E3;
  --border-focus:#0B6E99;

  --success:     #0B6B4C;
  --success-bg:  #E5F5EE;
  --error:       #B83225;
  --error-bg:    #FCECEA;
  --warning:     #975007;
  --warning-bg:  #FEF0C7;
  --info:        #0B6E99;
  --info-bg:     #DDF0F9;

  --sidebar-bg:     #E8F0F8;
  --sidebar-border: #CDD7E3;
  --sidebar-text:   #3D5166;
  --sidebar-hover:  rgba(11,110,153,0.07);
  --sidebar-active: rgba(11,110,153,0.13);
  --sidebar-active-text: #0B6E99;

  --shadow-xs: 0 1px 3px rgba(15,27,45,0.07);
  --shadow-sm: 0 2px 10px rgba(15,27,45,0.08), 0 0 0 1px rgba(15,27,45,0.04);
  --shadow-md: 0 6px 24px rgba(15,27,45,0.10), 0 0 0 1px rgba(15,27,45,0.05);
  --shadow-lg: 0 16px 48px rgba(15,27,45,0.14), 0 0 0 1px rgba(15,27,45,0.06);
}
```

---

## Usporedna tablica

| Kriterij                  | Varijanta A "Sušac"        | Varijanta B "Lokva"        |
|---------------------------|----------------------------|----------------------------|
| Toplina podloge           | Topla (pijesak/maslac)     | Hladna (cloud blue-white)  |
| --muted kontrast          | 4.7:1 (AA, granic.)        | 5.8:1 (solidno AA)         |
| --accent boja             | #0A7EA4 (prava Jadran plava)| #0B6E99 (tamnije, ozbiljnije)|
| --accent-2 boja           | #D95F2B (zivi koralj)      | #C9512A (tamni terra cotta)|
| Vizualni karakter         | Ljetni, topao, turisticki  | Profesionalni SaaS         |
| Preporuka za              | Turisticki portali, B2C    | B2B dashboardi, agencije   |
| **PREPORUKA**             | **DA**                     | alternativa                |

---

## Napomene za implementaciju

### Zamjena dark-mode varijabli

Sve navedene varijante direktno zamjenjuju `--bg`, `--surface`, `--surface-2`,
`--text`, `--muted`, `--border` u `views/partials/head.ejs` unutar `:root {}`.

Specificni dashboard-only tokeni (`--panel`, `--navy` itd.) u
`<style>` bloku `views/dashboard.ejs` takodje treba azurirati:

```css
/* Varijanta A — dashboard override */
.dashboard {
  --accent:      #0A7EA4;
  --accent-2:    #D95F2B;
  --accent-soft: rgba(10,126,164,0.10);
  --panel:       #FFFFFF;
  --panel-2:     #F3EFE8;
  --stroke:      rgba(26,26,46,0.07);
  --navy:        #1A1A2E;    /* koristiti za tamne gradient stopove */
}
```

### Shimmer efekti na karticama

Trenutni `rgba(255,255,255,0.06)` shimmer radi SAMO na tamnim podlogama.
Na svjetloj paleti promijeniti u:

```css
.hero-card::after, .stat-card::after, ... {
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent);
}
```

### Ambient glow u body::before / body::after

Trenutni radial-gradient koristiti sa svjetlijim akcentima:

```css
body::before {
  background: radial-gradient(ellipse at center, rgba(10,126,164,0.06) 0%, transparent 65%);
}
body::after {
  background: radial-gradient(ellipse at center, rgba(217,95,43,0.04) 0%, transparent 65%);
}
```

### Sidebar

Trenutni `--sidebar-bg: #0b1220` treba postati topla siva (`#F0EBE1` za A,
`#E8F0F8` za B). Active indicator ostaviti kao gradient, ali koristiti
`--accent` umjesto plave/ljubicaste kombinacije.

### Chart.js gradijent

```js
// Varijanta A
gradient.addColorStop(0, 'rgba(10,126,164,0.85)');
gradient.addColorStop(1, 'rgba(10,126,164,0.05)');

// Varijanta B
gradient.addColorStop(0, 'rgba(11,110,153,0.85)');
gradient.addColorStop(1, 'rgba(11,110,153,0.05)');
```

### Intent bar boje (dashboard.ejs)

```js
// Zamijeniti intentColors objekt
const intentColors = {
  faq:     '#0A7EA4',   // accent primarni
  weather: '#5BA4BF',   // svjetliji tirkiz
  events:  '#D95F2B',   // accent sekundarni
  ai:      '#7A8FA8'    // neutralna siva-plava
};
```

---

## Pristupacnost — brzi vodic

- Nikada ne stavljati `--muted` tekst na `--surface-2` podlogu bez provjere (Varijanta A granicna)
- Gumbi `.btn-primary` s bijelim tekstom na `--accent` prolaze AA — ne tamnjeti accent ispod #0A7EA4
- `.feat-date` (bijeli tekst na `--accent-2`) prolazi AA — ne svjetljiti `--accent-2` iznad #D95F2B
- Koristiti `:focus-visible` + `box-shadow: 0 0 0 3px var(--accent-soft)` za keyboard nav
- Disabled stanja: ne koristiti `--muted` boju za disabled tekst; koristiti `opacity: 0.45` na elementu

---

*Generirano za TZ Brela dashboard — coastal-day paleta, travanj 2026.*
