export function goBackOneTab(): void {
  const modals = document.querySelectorAll<HTMLElement>(".modal-overlay, #menu-dropdown, .menu-dropdown");
  for (let i = 0; i < modals.length; i++) {
    const el = modals[i];
    if (el && el.style.display !== "none" && getComputedStyle(el).display !== "none") {
      el.style.display = "none";
      return;
    }
  }

  const pathname = window.location.pathname;
  const isSubPage =
    pathname.includes("/broadcaster/") ||
    pathname.includes("/scanner/") ||
    pathname.includes("/secure-broadcaster/") ||
    pathname.includes("/offline-encoder/") ||
    pathname.includes("/offline-decoder/");

  if (window.history.length > 1 && document.referrer && !document.referrer.endsWith(pathname)) {
    window.history.back();
  } else if (isSubPage) {
    window.location.href = "../index.html";
  } else {
    window.location.href = "./index.html";
  }
}

export function initBackNavigation(): void {
  if (typeof window === "undefined" || !document.body) return;

  const pathname = window.location.pathname;
  const isSubPage =
    pathname.includes("/broadcaster/") ||
    pathname.includes("/scanner/") ||
    pathname.includes("/secure-broadcaster/") ||
    pathname.includes("/offline-encoder/") ||
    pathname.includes("/offline-decoder/");

  if (!document.getElementById("floating-back-btn-styles")) {
    const style = document.createElement("style");
    style.id = "floating-back-btn-styles";
    style.innerHTML = `
      .floating-back-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 20px;
        background: linear-gradient(135deg, rgba(30, 41, 59, 0.92), rgba(15, 23, 42, 0.98));
        color: #38bdf8;
        border: 1.5px solid rgba(56, 189, 248, 0.45);
        border-radius: 30px;
        font-weight: 700;
        font-size: 0.95rem;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 0 16px rgba(56, 189, 248, 0.25);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        cursor: pointer;
        user-select: none;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .floating-back-btn:hover, .floating-back-btn:active {
        transform: translateY(-2px) scale(1.04);
        background: linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(30, 41, 59, 0.98));
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.6), 0 0 24px rgba(56, 189, 248, 0.45);
        border-color: #38bdf8;
        color: #ffffff;
      }
    `;
    document.head.appendChild(style);
  }

  if (isSubPage && !document.getElementById("floating-back-btn")) {
    const backBtn = document.createElement("button");
    backBtn.id = "floating-back-btn";
    backBtn.className = "floating-back-btn";
    backBtn.type = "button";
    backBtn.setAttribute("aria-label", "Back to previous tab");
    backBtn.innerHTML = `<span>⬅ Back</span>`;
    backBtn.addEventListener("click", (e) => {
      e.preventDefault();
      goBackOneTab();
    });
    document.body.appendChild(backBtn);
  }
}
