export function bgCall(message) {
  return chrome.runtime.sendMessage(message).then((res) => {
    if (!res) throw new Error("No response from the recorder service.");
    if (!res.ok) throw new Error(res.error || "Recorder error.");
    return res;
  });
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
