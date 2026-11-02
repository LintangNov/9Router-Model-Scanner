# DESIGN.md — 9Router Model Scanner Web GUI

## 1. Overview & Architecture
Aplikasi ini adalah dashboard pemindai kesehatan model AI untuk *9Router local proxy* (`http://localhost:20128`).
- **Backend**: Native PowerShell (`System.Net.HttpListener`) bertindak sebagai local HTTP server & API bridge untuk request `/v1/models` dan `/v1/chat/completions`.
- **Frontend**: Single Page Application (SPA) berbasis Vanilla HTML5, CSS3 (Custom Properties), dan Modern JavaScript (ES6+ Async/Await).

---

## 2. Visual Identity & Aesthetic System
Menghindari *AI-slop* (komponen generik, border-radius berlebih, gradient pastel murahan).
- **Theme**: Dark Technical / Developer CLI Hybrid Minimalist.
- **Color Palette**:
  - `Background`: `#0d1117` (Deep Obsidian)
  - `Surface / Cards`: `#161b22` (Dark Slate)
  - `Borders`: `#30363d` (Subtle Wireframe)
  - `Text Primary`: `#f0f6fc`
  - `Text Muted`: `#8b949e`
  - `Accent / Active`: `#3fb950` (Terminal Green)
  - `Warning / Circuit Break`: `#d29922` (Amber)
  - `Error / Failed`: `#f85149` (Coral Red)
  - `Brand Accent`: `#58a6ff` (Electric Blue)
- **Typography**:
  - Display / Code: System Monospace (`JetBrains Mono`, `Fira Code`, `Consolas`, `ui-monospace`)
  - Body UI: Inter / System Sans-serif

---

## 3. Layout Structure & Wireframe Components
Dashboard dibagi menjadi 4 zona utama:

1. **Header & Connection Bar**
   - Brand Title: "9Router Scanner Web UI"
   - Host URL (`http://localhost:20128`) + API Key Input Field (masked with toggle).
   - Status Indicator: Backend PowerShell Server (Online/Offline) & Router Health.

2. **Scanner Configuration Panel (Toolbar)**
   - **Provider Multi-Selector**: Checkbox list / Tag chips terkelompok dengan pilihan *Select All*.
   - **Circuit Breaker Controls**:
     - Toggle Switch: `ON / OFF` (Default: ON).
     - Threshold Input (Number): Limit kegagalan berturut-turut sebelum auto-skip (Default: 10, Min: 1).
   - **Action Button**: `Start Scan` (Prominent Green) / `Abort Scan` (Red).

3. **Live Scanner Execution Panel**
   - Progress Bar & Stat Counter: Total Model, Active Models, Failed Models, Skipped Providers.
   - Terminal Log Viewer: Auto-scrolling real-time log yang menampilkan status HTTP (200 OK, 4xx/5xx ERR, Skipped).

4. **Recap & Analytics Dashboard**
   - Active Models Card: Daftar model siap pakai + tombol copy list.
   - Skipped Providers Card: Daftar provider yang terpicu Circuit Breaker.
   - Failure Breakdown Card: Log error detail per model.

---

## 4. Interaction States & Circuit Breaker UX Logic
- **Circuit Breaker Enabled**: Jika suatu provider menghasilkan error HTTP berturut-turut sesuai `Threshold` yang ditentukan pengguna, sisa model di provider tersebut langsung di-skip. Status badge: `SKIPPED (CIRCUIT BROKEN)`.
- **Circuit Breaker Disabled**: Semua model dalam provider akan tetap dites satu per satu tanpa memperdulikan riwayat error berturut-turut.
- **Real-time Feedback**: Baris log diperbarui tanpa lag, memberikan umpan balik instan saat testing `POST /v1/chat/completions`.

---

## 5. Quality & Anti-Slop Guidelines
- Wajib mengacu pada berkas `antislop.md` di direktori proyek.
- Hindari penggunaan framework CSS berat (Bootstrap/Tailwind via CDN jika tidak perlu).
- Hindari animasi mengambang/transisi lambat yang menghambat performa CLI-like experience.