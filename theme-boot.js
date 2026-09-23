(function () {
  try {
    const params = new URLSearchParams(location.search);
    let settings = null;
    try { settings = JSON.parse(sessionStorage.getItem("btr-theme") || "null"); } catch {}
    if (!settings && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get("btr-settings", (stored) => {
        try { apply(stored && stored["btr-settings"]); } catch {}
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes["btr-settings"]) {
          try { apply(changes["btr-settings"].newValue); } catch {}
        }
      });
    } else if (settings) {
      apply(settings);
    }

    function apply(s) {
      const theme = s && s.theme ? s.theme : "system";
      const high = Boolean(s && s.highContrast);
      const resolved = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : theme;
      document.documentElement.setAttribute("data-theme", resolved);
      document.documentElement.setAttribute("data-contrast", high ? "high" : "normal");
    }

    apply(null);
  } catch { /* never block page load */ }
})();
