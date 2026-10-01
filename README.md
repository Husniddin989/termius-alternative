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
- 🗂  **Ko'p tabli terminal** — xterm.js, 256 rang, avtomatik o'lcham
- 💻 **Lokal terminal** — kompyuteringizning o'z shell'i (zsh/bash/fish/PowerShell) alohida tabda
- ⚡ **Snippets** — 127 ta tayyor buyruq (Linux, Docker, Git, systemd, tarmoq, DB, Kubernetes…) kategoriyalar bo'yicha; `<placeholder>` bor buyruqlar Enter'siz yoziladi
- ⌨️ **Autocomplete** — terminalda yozayotganingizda tarix va snippetlardan taklif chiqadi, `→` bilan qabul qilinadi
- ✨ **AI yordamchi** — ⌘K / Ctrl+Shift+K: istalgan tilda yozing ("eng katta fayllarni top"), AI buyruqni tayyorlaydi; Insert / Run / Save as snippet. Xavfli buyruqlar (rm -rf, reboot…) model nima desa ham alohida belgilanadi
  - **Lokal AI — bepul, offline** (odatiy): [Ollama](https://ollama.com) orqali `qwen2.5-coder` modellari; Settings'dan bir tugma bilan yuklab olinadi, hech narsa kompyuterdan chiqmaydi
  - **Claude API** — eng yaxshi sifat; o'z Anthropic API kalitingiz bilan, kalit keychain'da saqlanadi
- 📁 **SFTP** — ikki panel (Local | Remote): drag & drop bilan fayl ko'chirish (progress bilan), papka yaratish, nomini o'zgartirish, o'chirish
- 🔏 **Known Hosts** — ishonilgan server kalitlarini ko'rish va o'chirish
- 🔀 **Port forwarding** — local (`-L`) va dynamic SOCKS5 (`-D`), start/stop bilan

## Roadmap

- [ ] Remote port forwarding (`-R`)
- [ ] Shifrlangan sinxronizatsiya (qurilmalar orasida)
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

## Android

Telefon versiyasida hostlar, SSH terminal (Esc/Tab/Ctrl/strelkalar paneli bilan), Known Hosts va mavzular bor.
Parollar Android'da ilovaning shaxsiy papkasida saqlanadi (boshqa ilovalar o'qiy olmaydi).

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
  completion.ts           terminal qatorini kuzatish, tarix, autocomplete
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
