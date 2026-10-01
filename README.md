# Termius Alternative

[Termius](https://termius.com/) ga o'xshash, ochiq va yengil, cross-platform SSH klient.
**Tauri 2** (Rust) + **React** + **xterm.js** asosida qurilgan — Windows, macOS va Linux uchun bitta kod bazasi.

## Hozirgi imkoniyatlar (MVP)

- 🖥  **Hostlar ro'yxati** — qo'shish, tahrirlash, o'chirish, guruhlash, qidiruv
- 🔐 **Autentifikatsiya** — parol yoki private key (passphrase bilan ham)
- 🗂  **Ko'p tabli terminal** — har bir ulanish alohida tabda, xterm.js (256 rang, havolalar bosiladi)
- 📐 **Avtomatik o'lcham** — oyna o'zgarsa, masofadagi PTY ham o'zgaradi
- 🛡  **Host key tekshiruvi** — trust-on-first-use (`known_hosts`), kalit o'zgarsa ulanish rad etiladi
- 🔑 **Sirlar saqlanmaydi** — parol/passphrase faqat ulanish vaqtida so'raladi

## Roadmap

- [ ] Parollarni OS keychain'da saqlash (macOS Keychain / Windows Credential Manager / libsecret)
- [ ] Yangi host kalitini tasdiqlash oynasi (fingerprint ko'rsatish)
- [ ] SFTP fayl menejeri
- [ ] Port forwarding (local / remote / dynamic)
- [ ] Snippets (tez-tez ishlatiladigan buyruqlar)
- [ ] SSH agent va jump host (ProxyJump)
- [ ] Shifrlangan sinxronizatsiya (qurilmalar orasida)
- [ ] Mobil (Android / iOS) — Tauri 2 mobile

## Ishga tushirish

Talablar: [Node.js 20+](https://nodejs.org/), [Rust](https://rustup.rs/) va
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (Linux'da `libwebkit2gtk-4.1-dev` va boshqalar).

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # installer / bundle yaratish
```

## Testlar

```bash
cd src-tauri
cargo test

# Haqiqiy SSH serverga qarshi end-to-end test:
SSH_TEST_ADDR=127.0.0.1:22 SSH_TEST_USER=me SSH_TEST_PASSWORD=... cargo test -- --ignored
```

## Arxitektura

```
src/                      React UI
  api.ts                  Tauri buyruqlari + SshSession (stream buferi)
  components/
    HostList.tsx          hostlar ro'yxati
    HostForm.tsx          host qo'shish/tahrirlash
    ConnectDialog.tsx     parol / passphrase so'rash
    TerminalView.tsx      xterm.js terminal
src-tauri/src/
  lib.rs                  Tauri buyruqlari (hosts_*, ssh_*)
  hosts.rs                hosts.json saqlash (app data papkasi)
  ssh.rs                  russh asosidagi sessiyalar, known_hosts
```

Har bir SSH sessiya alohida tokio task'da ishlaydi. UI kiritishni `ssh_write` orqali yuboradi,
chiqish esa Tauri IPC `Channel` orqali oqim sifatida keladi.
