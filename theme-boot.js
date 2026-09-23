// Anti-flash theme boot. Runs synchronously before page paint.
(function () {
  var dark;
  try {
    var cached = localStorage.getItem("btr-theme");
    if (cached) {
      var parts = cached.split("|");
      var theme = parts[0] || "system";
      var highContrast = parts[1] === "1";
      dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      if (highContrast) document.documentElement.classList.add("high-contrast");
      return;
    }
  } catch (e) {}
  // v1.0.3: was `var dark` — redeclaring the function-scoped var from the try block.
  dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try {
    chrome.storage.local.get("settings", function (result) {
      var s = result && result.settings;
      var theme = (s && s.theme) || "system";
      var highContrast = s && s.highContrast;
      var d = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", d ? "dark" : "light");
      if (highContrast) document.documentElement.classList.add("high-contrast");
      else document.documentElement.classList.remove("high-contrast");
      try { localStorage.setItem("btr-theme", theme + "|" + (highContrast ? "1" : "0")); } catch (e) {}
    });
  } catch (e) {}
})();
