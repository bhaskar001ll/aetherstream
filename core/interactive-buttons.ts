export function initInteractiveButtons() {
  if (typeof window === "undefined" || !document.body) return;

  // 1. Inject CSS for Ripple and Smooth Transitions
  if (!document.getElementById("interactive-btn-styles")) {
    const style = document.createElement("style");
    style.id = "interactive-btn-styles";
    style.innerHTML = `
      @keyframes ripple-anim {
        to {
          transform: scale(4);
          opacity: 0;
        }
      }
      .ripple-effect {
        position: absolute;
        border-radius: 50%;
        transform: scale(0);
        animation: ripple-anim 0.6s linear;
        background-color: rgba(255, 255, 255, 0.3);
        pointer-events: none;
      }
      button, .hero-badge, summary, a.download, .mode-card {
        transition: transform 0.1s ease, filter 0.1s ease, background-color 0.3s ease !important;
      }
      .post-click-flash {
        filter: brightness(1.3) contrast(1.1) !important;
      }
    `;
    document.head.appendChild(style);
  }

  const getInteractiveEl = (target: EventTarget | null) => {
    if (!target) return null;
    return (target as HTMLElement).closest("button, .hero-badge, summary, a.download, .mode-card") as HTMLElement | null;
  };

  // 2. Ripple Effect on Click
  document.body.addEventListener("click", (e) => {
    const btn = getInteractiveEl(e.target);
    if (!btn || (btn as HTMLButtonElement).disabled) return;

    const rect = btn.getBoundingClientRect();
    const diameter = Math.max(btn.clientWidth, btn.clientHeight);
    const radius = diameter / 2;

    const circle = document.createElement("span");
    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${e.clientX - rect.left - radius}px`;
    circle.style.top = `${e.clientY - rect.top - radius}px`;
    circle.classList.add("ripple-effect");

    if (getComputedStyle(btn).position === "static") {
      btn.style.position = "relative";
    }
    btn.style.overflow = "hidden";

    btn.appendChild(circle);
    
    // Post-click flash effect
    btn.classList.add("post-click-flash");
    setTimeout(() => btn.classList.remove("post-click-flash"), 300);

    setTimeout(() => circle.remove(), 600);
  });

  // 3. Tactile Scale/Brightness Effect on Press
  const applyPressEffect = (btn: HTMLElement) => {
    if ((btn as HTMLButtonElement).disabled) return;
    btn.style.transform = "scale(0.96)";
    btn.style.filter = "brightness(0.9)";
  };

  const removePressEffect = (btn: HTMLElement) => {
    btn.style.transform = "scale(1)";
    btn.style.filter = "brightness(1)";
  };

  document.body.addEventListener("pointerdown", (e) => {
    const btn = getInteractiveEl(e.target);
    if (btn) applyPressEffect(btn);
  });

  document.body.addEventListener("pointerup", (e) => {
    const btn = getInteractiveEl(e.target);
    if (btn) removePressEffect(btn);
  });

  document.body.addEventListener("pointercancel", (e) => {
    const btn = getInteractiveEl(e.target);
    if (btn) removePressEffect(btn);
  });

  document.body.addEventListener("pointerout", (e) => {
    const btn = getInteractiveEl(e.target);
    if (btn) {
      const related = e.relatedTarget as Node | null;
      if (!related || !btn.contains(related)) {
        removePressEffect(btn);
      }
    }
  });
}
