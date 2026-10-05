# Termius Alternative

[Termius](https://termius.com/) ga o'xshash, ochiq va yengil, cross-platform SSH klient.
**Tauri 2** (Rust) + **React** + **xterm.js** asosida qurilgan — Windows, macOS va Linux uchun bitta kod bazasi.

## Imkoniyatlar

- 🎨 **Mavzular** — Midnight, Ocean, Amethyst, Forest, Ember, Daylight (yorug') va Auto (tizimga moslashadi); terminal ranglari ham mavzuga mos o'zgaradi
- 🖥  **Hostlar** — guruhlar, qidiruv, `user@host` yozib tez ulanish, o'ng panelda tahrirlash, o'ng tugma menyusi
- 🐧 **OS aniqlash** — birinchi ulanishda server OS'i aniqlanib, ikonka rangi shunga moslanadi
- 🔐 **Autentifikatsiya** — parol, private key (passphrase bilan) yoki **SSH agent**
- 🔑 **Keychain** — parol/passphrase'ni OS keychain'da saqlash (macOS Keychain, Windows Credential Manager, Linux Secret Service). Diskdagi JSON'da sir saqlanmaydi
- 🧭 **Jump host** (ProxyJump) — boshqa saqlangan host orqali ulanish
- 🛡  **Host key tekshiruvi** — yangi serverda fingerprint ko'rsatilib tasdiq so'raladi; kalit o'zgarsa ulanish rad etiladi
- 🗂  **Ko'p tabli terminal** — xterm.js, 256 rang, avtomatik o'lcham; ulanish uzilsa **Reconnect** (yoki Enter) — terminal tarixi saqlanadi
- 💻 **Lokal terminal** — kompyuteringizning o'z shell'i (zsh/bash/fish/PowerShell) alohida tabda
- ⚡ **Snippets** — 127 ta tayyor buyruq (Linux, Docker, Git, systemd, tarmoq, DB, Kubernetes…) kategoriyalar bo'yicha; `<placeholder>` bor buyruqlar Enter'siz yoziladi
- ⌨️ **Autocomplete** — yozayotganingizda buyruqlar, subcommand va flag'lar (git, docker, systemctl, kubectl, apt… — tavsifi bilan),
  serverdagi papka/fayllar va serverning o'z shell tarixi (`~/.bash_history`, `~/.zsh_history`) taklif qilinadi;
  `→` yoki `Tab` bilan qabul, `↑`/`↓` bilan tanlash, `Esc` bilan yopish
- ✨ **AI yordamchi** — ⌘K / Ctrl+Shift+K: istalgan tilda yozing ("eng katta fayllarni top"), AI buyruqni tayyorlaydi; Insert / Run / Save as snippet. Xavfli buyruqlar (rm -rf, reboot…) model nima desa ham alohida belgilanadi
  - **Lokal AI — bepul, offline** (odatiy): [Ollama](https://ollama.com) orqali `qwen2.5-coder` modellari; Settings'dan bir tugma bilan yuklab olinadi, hech narsa kompyuterdan chiqmaydi
  - **Claude API** — eng yaxshi sifat; o'z Anthropic API kalitingiz bilan, kalit keychain'da saqlanadi
- 📁 **SFTP** — ikki panel (Local | Remote): drag & drop bilan fayl ko'chirish (progress bilan), papka yaratish, nomini o'zgartirish, o'chirish
- 🔏 **Known Hosts** — ishonilgan server kalitlarini ko'rish va o'chirish
- 📥 **Import** — Hosts → Import: `~/.ssh/config`, istalgan SSH config fayli, Termius CLI eksporti
  (`termius export-ssh-config` → `~/.termius/sshconfig`) yoki CSV (Termius shabloni: `Groups, Label, Hostname/IP, Port, Username, Password, SSH_KEY`).
  Oldindan ko'rish, allaqachon bor hostlarni o'tkazib yuborish, ProxyJump → jump host, parollar keychain'ga
- 🔀 **Port forwarding** — local (`-L`) va dynamic SOCKS5 (`-D`), start/stop bilan
- 🔄 **Sinxronizatsiya** — hostlar, saqlangan parollar, private key'lar, snippetlar va forwarding qoidalari kompyuter ↔ telefon o'rtasida
  GitHub'dagi **secret Gist** orqali sinxronlanadi. Hammasi qurilmaning o'zida sync parol bilan shifrlanadi
  (Argon2id → XChaCha20-Poly1305) — GitHub faqat shifrlangan matnni ko'radi. Har bir yozuv bo'yicha birlashtiriladi:
  yangiroq tahrir yutadi, o'chirishlar ham boshqa qurilmaga o'tadi

### Sinxronizatsiyani yoqish

1. GitHub'da faqat **gist** ruxsati bor token yarating (Settings → Sync → *open GitHub*).
2. Kompyuterda: Settings → Sync → token va sync parolni kiriting → **Turn on sync**.
3. Telefonda: xuddi shu token (yoki shu akkauntdagi boshqa token) va **xuddi shu sync parol** bilan yoqing.

Ilova ochilganda, har 3 daqiqada, oynaga qaytganda va har o'zgarishdan keyin avtomatik sinxronlanadi.
Key bilan kiriladigan hostlarning private key fayllari ham (shifrlangan holda) o'tadi: faylni o'zida yo'q qurilmada
(masalan telefonda) ilova uni o'zining yopiq papkasida saqlaydi; `~/.ssh` dagi fayllar hech qachon ustidan yozilmaydi.
Sync parolni unutsangiz uni tiklab bo'lmaydi: GitHub'dagi gist'ni o'chirib, sync'ni qaytadan yoqing.

## Roadmap

- [ ] Remote port forwarding (`-R`)
- [x] Shifrlangan sinxronizatsiya (qurilmalar orasida)
- [x] Android ilova (hostlar + SSH terminal)
- [ ] iOS ilova
- [ ] Split-pane terminal, temalar

## Ishga tushirish

Talablar: [Node.js 20+](https://nodejs.org/), [Rust](https://rustup.rs/) va
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (Linux'da `libwebkit2gtk-4.1-dev`, `libdbus-1-dev` va boshqalar).

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # installer / bundle yaratish
```

## Yuklab olish va relizlar

- **Sayt** (`website/`): imkoniyatlar, skrinshotlar va har bir tizim uchun yuklab olish tugmalari (EN/UZ).
  Oddiy statik sayt — build kerak emas.
  - **Vercel:** Add New → Project → shu repo'ni import qiling → **Root Directory: `website`**,
    Framework Preset: **Other** → Deploy. Keyin main'ga har push saytni avtomatik yangilaydi.
  - **GitHub Pages** (ixtiyoriy): **Settings → Pages → Source: GitHub Actions**, `Website` workflow chiqaradi.
- **Release** workflow macOS (`.dmg`, Apple Silicon + Intel), Windows (`.exe`), Linux (`.AppImage`, `.deb`) va
  Android (`.apk`) ni yig'ib, doimiy nomlar bilan GitHub Release'ga qo'yadi, sayt esa
  `releases/latest/download/<fayl>` ga havola qiladi. Ishga tushirish: **Actions → Release → Run workflow**,
  `v0.2.0` kabi tag, yoki commit xabarida `[release]` bilan main'ga push.
- APK imzolanishi uchun repo secret'lari kerak: `ANDROID_KEYSTORE_B64` (`base64 -w0 termius-release.jks`)
  va `ANDROID_KEYSTORE_PASSWORD`. Ular bo'lmasa relizda APK bo'lmaydi.
- Boshqalar yuklab olishi uchun repo **public** bo'lishi kerak (private repo relizlari va Pages faqat sizga ko'rinadi).

**macOS:** ilova Apple tomonidan notarize qilinmagan, birinchi ochishdan oldin Terminal'da bir marta:
```bash
xattr -dr com.apple.quarantine "/Applications/Termius Alternative.app"
```

## Android

Telefon versiyasida hostlar, SSH terminal (Esc/Tab/Ctrl/strelkalar paneli, barmoq bilan scroll), Known Hosts, sync va mavzular bor.
Sessiyalar ochiq bo'lsa foreground service (bildirishnoma bilan) ilovani fonda ham tirik saqlaydi; tarmoq uzilsa
ilova o'zi qayta ulanadi. Parollar Android'da ilovaning shaxsiy papkasida saqlanadi (boshqa ilovalar o'qiy olmaydi).

Talablar: Android SDK (platform 36, build-tools), NDK 27, JDK 17+.

```bash
export ANDROID_HOME=~/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/27.3.13750724
rustup target add aarch64-linux-android
npm run tauri android build -- --apk --target aarch64
# Imzolash (bir marta yaratilgan kalit bilan):
zipalign -p 4 app-universal-release-unsigned.apk aligned.apk
apksigner sign --ks termius-release.jks --out termius.apk aligned.apk
```

Yangilanishlarni o'rnatish uchun har safar **o'sha bitta** kalit bilan imzolash kerak.

## Testlar

```bash
cd src-tauri
cargo test

# Haqiqiy SSH serverga qarshi end-to-end testlar (shell, jump host, SFTP,
# port forwarding; agent testi uchun SSH_AUTH_SOCK'da kalit bo'lishi kerak):
SSH_TEST_ADDR=127.0.0.1:22 SSH_TEST_USER=me SSH_TEST_PASSWORD=... cargo test -- --include-ignored

# Haqiqiy Ollama bilan:
OLLAMA_TEST_MODEL=qwen2.5-coder:3b cargo test real_ollama -- --ignored --nocapture
```

## Arxitektura

```
src/                      React UI
  App.tsx                 oyna: yuqori tablar (Home, SFTP, sessiyalar) + chap menyu
  api.ts                  Tauri buyruqlari + SshSession (stream buferi)
  useConnector.tsx        keychain → so'rov → qayta urinish oqimi
  completion.ts           terminal qatorini kuzatish, autocomplete (buyruq/flag/yo'l/tarix)
  commandSpecs.ts         buyruqlar, subcommand va flag'lar lug'ati
  themes.ts               rang mavzulari (UI + terminal)
  snippetLibrary.ts       tayyor buyruqlar kutubxonasi
  components/
    HostsPage.tsx         qidiruv / tez ulanish, guruhlar, host kartalari
    HostDetails.tsx       o'ng panel: hostni tahrirlash va ulanish
    SftpPage.tsx          ikki panelli SFTP (Local | Remote, drag & drop)
    TerminalView.tsx      xterm.js terminal + snippetlar paneli
    ForwardsPage.tsx      port forwarding qoidalari
    SnippetsPage.tsx      snippetlar
    KnownHostsPage.tsx    ishonilgan server kalitlari
    SettingsPage.tsx      AI kaliti, model, kutubxona
src-tauri/src/
  lib.rs                  Tauri buyruqlari
  conn.rs                 ulanish: auth (parol/kalit/agent), jump host, known_hosts
  hostkey.rs              host kalitini UI orqali tasdiqlash
  ssh.rs                  terminal sessiyalari
  sftp.rs                 SFTP (russh-sftp)
  forward.rs              local va SOCKS5 forwarding
  knownhosts.rs           known_hosts ro'yxati / o'chirish
  localfs.rs              lokal fayllar (SFTP chap paneli)
  secrets.rs              OS keychain (keyring)
  pty.rs                  lokal terminal (portable-pty, faqat desktop)
  ai.rs                   AI buyruq takliflari: umumiy prompt + Claude Messages API
  ollama.rs               lokal AI (Ollama): modellar ro'yxati, yuklab olish, takliflar
  settings.rs             sozlamalar (model, AI va kutubxona)
  store.rs                hosts / snippets / forwards JSON saqlash
```

Har bir SSH sessiya alohida tokio task'da ishlaydi. UI kiritishni `ssh_write` orqali yuboradi,
chiqish esa Tauri IPC `Channel` orqali oqim sifatida keladi.
