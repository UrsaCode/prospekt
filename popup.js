// Prospekt — Popup

const send = msg => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res);
    });
  } catch { resolve(null); }
});

const setText = (id, value) => { document.getElementById(id).textContent = value; };

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

(async () => {
  const [stats, settings] = await Promise.all([
    send({ action: "getStats" }),
    send({ action: "getSettings" }),
  ]);

  if (stats) {
    setText("sE", Number(stats.emails || 0).toLocaleString());
    setText("sP", Number(stats.phones || 0).toLocaleString());
    setText("sS", Number(stats.socials || 0).toLocaleString());
    setText("sC", Number(stats.customs || 0).toLocaleString());
  }

  // v1 hardcoded "active" here, so a paused extension still claimed to be scanning.
  const on = settings ? settings.autoScan !== false : true;
  const el = document.getElementById("scanState");
  el.textContent = on ? "active" : "paused";
  el.classList.toggle("paused", !on);
})();

document.getElementById("openBtn").addEventListener("click", async () => {
  await send({ action: "openDashboard" });
  window.close();
});
