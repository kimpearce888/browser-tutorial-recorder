const TRANSIENT_RE = /message port closed|receiving end does not exist/i;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function bgCall(message, retries = 2) {
  const attempt = (n) => Promise.resolve()
    .then(() => chrome.runtime.sendMessage(message))
    .then((res) => {
      if (res) {
        if (!res.ok) throw new Error(res.error || "Recorder error.");
        return res;
      }
      if (n <= 0) throw new Error("No response from the recorder service.");
      return sleep(350).then(() => attempt(n - 1));
    })
    .catch((e) => {
      if (n > 0 && e instanceof Error && TRANSIENT_RE.test(e.message)) {
        return sleep(350).then(() => attempt(n - 1));
      }
      throw e;
    });
  return attempt(retries);
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
