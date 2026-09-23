(function () {
  let dark;
  try {
    const cached = localStorage.getItem("btr-theme");
    if (cached) {
      const parts = cached.split("|");
      const theme = parts[0] || "system";
      const highContrast = parts[1] === "1";
      dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      if (highContrast) document.documentElement.classList.add("high-contrast");
      return;
    }
  } catch (e) {}

  dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try {
    chrome.storage.local.get("settings", function (result) {
      const s = result && result.settings;
      const theme = (s && s.theme) || "system";
      const highContrast = s && s.highContrast;
      const d = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", d ? "dark" : "light");
      if (highContrast) document.documentElement.classList.add("high-contrast");
      else document.documentElement.classList.remove("high-contrast");
      try { localStorage.setItem("btr-theme", theme + "|" + (highContrast ? "1" : "0")); } catch (e) {}
    });
  } catch (e) {}
})();
