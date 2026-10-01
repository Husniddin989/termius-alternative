/** Running inside the Android/iOS app (phone or tablet). */
export const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

if (IS_MOBILE) document.documentElement.classList.add("mobile");
