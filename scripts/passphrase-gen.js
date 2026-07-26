/**
 * Browser-only CRM data passphrase generator (32 random bytes → base64).
 * Used on worker.html / docs/worker-setup.html — nothing is sent to a server.
 */
(function () {
  function generatePassphrase() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function wire(root) {
    if (!root) return;
    var out = root.querySelector("[data-passphrase-out]");
    var genBtn = root.querySelector("[data-passphrase-generate]");
    var copyBtn = root.querySelector("[data-passphrase-copy]");
    var status = root.querySelector("[data-passphrase-status]");
    if (!out || !genBtn) return;

    function setStatus(msg) {
      if (status) status.textContent = msg || "";
    }

    function fill() {
      try {
        out.value = generatePassphrase();
        setStatus("New passphrase generated — copy it into the Worker secret and console.");
      } catch (err) {
        setStatus("Could not generate (need a modern browser with Web Crypto).");
      }
    }

    genBtn.addEventListener("click", function () {
      fill();
    });

    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var v = String(out.value || "").trim();
        if (!v) {
          fill();
          v = String(out.value || "").trim();
        }
        if (!v) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(
            function () {
              setStatus("Copied to clipboard.");
            },
            function () {
              out.select();
              setStatus("Select and copy manually (Ctrl/Cmd+C).");
            },
          );
        } else {
          out.select();
          setStatus("Select and copy manually (Ctrl/Cmd+C).");
        }
      });
    }
  }

  function boot() {
    document.querySelectorAll("[data-passphrase-gen]").forEach(wire);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
