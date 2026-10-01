# Termius Alternative

[Termius](https://termius.com/) ga o'xshash, ochiq va yengil, cross-platform SSH klient.
**Tauri 2** (Rust) + **React** + **xterm.js** asosida qurilgan — Windows, macOS va Linux uchun bitta kod bazasi.

## Imkoniyatlar

- 🖥  **Hostlar** — qo'shish, tahrirlash, guruhlash, qidiruv
- 🔐 **Autentifikatsiya** — parol, private key (passphrase bilan) yoki **SSH agent**
- 🔑 **Keychain** — parol/passphrase'ni OS keychain'da saqlash (macOS Keychain, Windows Credential Manager, Linux Secret Service). Diskdagi JSON'da sir saqlanmaydi
- 🧭 **Jump host** (ProxyJump) — boshqa saqlangan host orqali ulanish
- 🛡  **Host key tekshiruvi** — yangi serverda fingerprint ko'rsatilib tasdiq so'raladi; kalit o'zgarsa ulanish rad etiladi
- 🗂  **Ko'p tabli terminal** — xterm.js, 256 rang, avtomatik o'lcham
- ⚡ **Snippets** — saqlangan buyruqlar, terminaldagi ⚡ tugmasidan bir bosishda ishga tushadi
- 📁 **SFTP** — fayl brauzeri: kirish/chiqish, yuklash va yuklab olish (progress bilan), papka yaratish, nomini o'zgartirish, o'chirish
- 🔀 **Port forwarding** — local (`-L`) va dynamic SOCKS5 (`-D`), start/stop bilan

## Roadmap

- [ ] Remote port forwarding (`-R`)
- [ ] Shifrlangan sinxronizatsiya (qurilmalar orasida)
- [ ] Mobil (Android / iOS) — Tauri 2 mobile
- [ ] Split-pane terminal, temalar

## Ishga tushirish

Talablar: [Node.js 20+](https://nodejs.org/), [Rust](https://rustup.rs/) va
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (Linux'da `libwebkit2gtk-4.1-dev`, `libdbus-1-dev` va boshqalar).

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # installer / bundle yaratish
```

## Testlar

```bash
cd src-tauri
cargo test

# Haqiqiy SSH serverga qarshi end-to-end testlar (shell, jump host, SFTP,
# port forwarding; agent testi uchun SSH_AUTH_SOCK'da kalit bo'lishi kerak):
SSH_TEST_ADDR=127.0.0.1:22 SSH_TEST_USER=me SSH_TEST_PASSWORD=... cargo test -- --include-ignored
```

## Arxitektura

```
src/                      React UI
  api.ts                  Tauri buyruqlari + SshSession (stream buferi)
  components/
    HostList.tsx          hostlar ro'yxati
    HostForm.tsx          host qo'shish/tahrirlash
    ConnectDialog.tsx     parol / passphrase so'rash
    HostKeyDialog.tsx     yangi host kalitini tasdiqlash
    TerminalView.tsx      xterm.js terminal + snippet palitrasi
    SftpView.tsx          SFTP fayl brauzeri
    SnippetsView.tsx      snippetlar
    ForwardsView.tsx      port forwarding qoidalari
  useConnector.tsx        keychain → so'rov → qayta urinish oqimi
src-tauri/src/
  lib.rs                  Tauri buyruqlari
  conn.rs                 ulanish: auth (parol/kalit/agent), jump host, known_hosts
  hostkey.rs              host kalitini UI orqali tasdiqlash
  ssh.rs                  terminal sessiyalari
  sftp.rs                 SFTP (russh-sftp)
  forward.rs              local va SOCKS5 forwarding
  secrets.rs              OS keychain (keyring)
  store.rs                hosts / snippets / forwards JSON saqlash
```

Har bir SSH sessiya alohida tokio task'da ishlaydi. UI kiritishni `ssh_write` orqali yuboradi,
chiqish esa Tauri IPC `Channel` orqali oqim sifatida keladi.
