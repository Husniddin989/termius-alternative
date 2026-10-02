// Download links always point at the newest GitHub release; the release
// workflow uploads every build under these fixed names.
const RELEASES = "https://github.com/Husniddin989/termius-alternative/releases/latest/download/";

const UZ = {
  navFeatures: "Imkoniyatlar",
  navDownload: "Yuklab olish",
  pill: "Bepul va ochiq kodli",
  heroTitle: "Serverlaringiz — har bir qurilmada, bir bosishda.",
  heroLead:
    "macOS, Windows, Linux va Android uchun tezkor SSH klient. Hostlar, parollar va kalitlar shifrlangan holda sinxronlanadi, terminal esa yozishingizga yordam beradi.",
  downloadFor: "Yuklab olish:",
  allDownloads: "Barcha versiyalar",
  heroFine: "Akkaunt ham, obuna ham yo'q. Ma'lumotlaringiz o'z qurilmalaringizda qoladi.",
  featuresTitle: "Har kungi server ishlari uchun hammasi bor",
  f1t: "Shell'ni tushunadigan autocomplete",
  f1d: "Buyruqlar, subcommand va flag'larni qisqa izoh bilan, serverdagi papka va fayllarni hamda serverdagi o'z tarixingizni taklif qiladi. → yoki Tab bilan qabul qilinadi.",
  f2t: "Shifrlangan sinxronizatsiya",
  f2d: "Hostlar, saqlangan parollar va private key'lar kompyuterdan telefonga o'z GitHub akkauntingizdagi yashirin gist orqali o'tadi — qurilmaning o'zida shifrlanadi, GitHub ularni ko'rmaydi.",
  f3t: "Buyruqni AI yozib beradi",
  f3d: "Nima kerakligini istalgan tilda yozing — tayyor buyruqni olasiz. Ollama bilan lokal va bepul ishlaydi yoki o'z Claude API kalitingiz bilan. Xavfli buyruqlar alohida belgilanadi.",
  f4t: "Hostlar, guruhlar, jump host",
  f4d: "Serverlarni guruhlarga ajrating, parol, kalit yoki SSH agent bilan ulaning, bastion orqali o'ting. Parollar tizim keychain'ida saqlanadi.",
  f5t: "Telefonda haqiqiy terminal",
  f5d: "Qo'shimcha tugmalar (Esc, Tab, Ctrl, strelkalar), barmoq bilan scroll, fonda ham uzilmaydigan va tarmoq almashganda o'zi qayta ulanadigan sessiyalar.",
  f6t: "SFTP va port forwarding",
  f6d: "Fayllarni kompyuter va server orasida sudrab ko'chiring. Local (-L) va SOCKS (-D) tunnellarni bir bosishda yoqib-o'chiring.",
  f7t: "Xavfsiz",
  f7d: "Server kalitlari OpenSSH kabi tekshiriladi, kalit o'zgarsa ulanish to'xtatiladi. Rust'da yozilgan, telemetriya yo'q.",
  f8t: "Mavzular",
  f8d: "Midnight, Ocean, Amethyst, Forest, Ember, Daylight — yoki tizimga moslashsin. Terminal ranglari ham mavzu bilan o'zgaradi.",
  cap1: "Hostlar va guruhlar; har bir serverning OS'i birinchi ulanishda aniqlanadi.",
  cap2: "O'sha hostlar telefoningizda.",
  downloadTitle: "Yuklab olish",
  downloadSub: "Har doim eng so'nggi versiya. Shaxsiy va tijoriy foydalanish uchun bepul.",
  dl: "Yuklab olish",
  howInstall: "Qanday o'rnatiladi",
  macMeta: "Apple Silicon va Intel · macOS 11+",
  mac1: ".dmg ni oching va ilovani Applications papkasiga torting.",
  mac2: "Ilova hali Apple tomonidan notarize qilinmagan, shuning uchun birinchi ochishdan oldin Terminal'da bir marta bajaring:",
  mac3: "Yoki: System Settings → Privacy & Security → “Open Anyway”.",
  winMeta: "Windows 10 va 11 · 64-bit",
  win1: "O'rnatuvchini ishga tushiring.",
  win2: "SmartScreen ogohlantirsa, “More info” → “Run anyway” ni bosing (o'rnatuvchi hali imzolanmagan).",
  linuxMeta: "x86_64 · AppImage yoki Debian/Ubuntu paketi",
  lin1: "AppImage: bajariladigan qiling va ishga tushiring:",
  lin2: "Debian/Ubuntu:",
  androidMeta: "Android 7+ · arm64 telefonlar",
  and1: "Yuklangan .apk faylni oching.",
  and2: "Android so'raganda brauzer yoki fayl menejeriga “Noma'lum ilovalarni o'rnatish”ga ruxsat bering.",
  and3: "Yangilanishlar eski versiya ustidan o'rnatiladi — hostlaringiz saqlanib qoladi.",
  allReleases: "Barcha versiyalar va o'zgarishlar ro'yxati →",
  copy: "Nusxa",
  copied: "Nusxalandi",
  faqTitle: "Savollar",
  q1: "Haqiqatan bepulmi?",
  a1: "Ha. Akkaunt ham, pullik tarif ham yo'q. Manba kodi GitHub'da.",
  q2: "Parollarim qayerda saqlanadi?",
  a2: "Tizim keychain'ida (macOS Keychain, Windows Credential Manager, Linux'da Secret Service), Android'da esa ilovaning yopiq xotirasida. Sinxronizatsiya ularni faqat sync parolingiz bilan shifrlab yuklaydi.",
  q3: "Sinxronizatsiya qanday ishlaydi?",
  a3: "Settings → Sync: faqat “gist” ruxsati bor GitHub token va sync parolni kiriting. Boshqa qurilmalarda ham xuddi shu parol bilan yoqing. Ilova ochilganda, har bir necha daqiqada va har o'zgarishdan keyin sinxronlanadi.",
  q4: "AI ma'lumotlarimni biror joyga yuboradimi?",
  a4: "Odatiy lokal AI (Ollama) bilan — yo'q, hammasi kompyuteringizda qoladi. Claude API'ni tanlasangiz, so'rov o'z kalitingiz bilan Anthropic'ga boradi.",
  notAffiliated: "Mustaqil ochiq kodli loyiha, Termius bilan bog'liq emas.",
};

const OS_NAMES = { mac: "macOS", windows: "Windows", linux: "Linux", android: "Android" };
const OS_NAMES_UZ = { mac: "macOS uchun", windows: "Windows uchun", linux: "Linux uchun", android: "Android uchun" };

function detectOs() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return null; // no iOS app yet
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11/i.test(ua)) return "linux";
  return null;
}

const english = new Map();
document.querySelectorAll("[data-i18n]").forEach((el) => english.set(el, el.innerHTML));

let lang = "en";
const os = detectOs();

function t(key, fallback) {
  return lang === "uz" && UZ[key] ? UZ[key] : fallback;
}

function render() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    el.innerHTML = lang === "uz" && UZ[key] ? UZ[key] : english.get(el);
  });
  document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));

  const heroOs = document.getElementById("hero-os");
  const heroBtn = document.getElementById("hero-download");
  if (os) {
    const card = document.querySelector(`.card[data-os="${os}"] .btn.primary`);
    heroOs.textContent = lang === "uz" ? OS_NAMES_UZ[os] : OS_NAMES[os];
    heroBtn.querySelector("[data-i18n]").textContent = lang === "uz" ? "Yuklab olish —" : "Download for";
    heroBtn.href = card.href;
  } else {
    heroBtn.textContent = t("dl", "Download");
    heroBtn.href = "#download";
  }
}

document.querySelectorAll("[data-file]").forEach((a) => (a.href = RELEASES + a.dataset.file));
if (os) document.querySelector(`.card[data-os="${os}"]`)?.classList.add("mine");

document.querySelectorAll("[data-lang]").forEach((b) =>
  b.addEventListener("click", () => {
    lang = b.dataset.lang;
    try {
      localStorage.setItem("lang", lang);
    } catch {}
    render();
  }),
);

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const code = btn.parentElement.querySelector("code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = t("copied", "Copied");
    setTimeout(() => (btn.textContent = t("copy", "Copy")), 1500);
  } catch {}
});

try {
  const saved = localStorage.getItem("lang");
  if (saved === "en" || saved === "uz") lang = saved;
  else if ((navigator.language || "").toLowerCase().startsWith("uz")) lang = "uz";
} catch {}
document.getElementById("year").textContent = new Date().getFullYear();
render();
