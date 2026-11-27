const DEMO_LENSES = [
  { label: "Studio Clean", filter: "contrast(1.06) saturate(1.06)", dark: false },
  { label: "Golden Hour", filter: "sepia(0.24) saturate(1.32) brightness(1.06)", dark: false },
  { label: "Y2K Digicam", filter: "contrast(1.26) saturate(1.18)", dark: true },
  { label: "Velvet Noir", filter: "grayscale(1) contrast(1.32)", dark: true },
  { label: "Neon Signal", filter: "contrast(1.24) saturate(1.36) hue-rotate(12deg)", dark: true },
];

export function initHomepageMotion() {
  const stage = document.getElementById("kineticStage");
  const rig = document.getElementById("kineticRig");
  const strip = document.getElementById("demoStrip");
  const lensTag = document.getElementById("kineticLensName");
  const frameCounter = document.getElementById("kineticFrameTag");
  const pills = [...document.querySelectorAll(".kinetic-pill")];
  const frames = [...document.querySelectorAll(".demo-frame")];
  const arts = [...document.querySelectorAll(".demo-frame-art")];

  if (!stage || !strip || !frames.length) return () => {};

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let step = 0;

  const tick = () => {
    const activeFrame = step % frames.length;
    const lens = DEMO_LENSES[Math.floor(step / 2) % DEMO_LENSES.length];

    frames.forEach((f, idx) => f.classList.toggle("is-active", idx === activeFrame));
    arts.forEach((a) => {
      a.style.filter = lens.filter;
    });

    strip.classList.toggle("is-midnight", lens.dark);
    if (!reduced) {
      strip.classList.remove("is-flashing");
      void strip.offsetWidth;
      strip.classList.add("is-flashing");
    }

    if (lensTag) lensTag.textContent = lens.label;
    if (frameCounter) frameCounter.textContent = `0${activeFrame + 1} / 04`;

    pills.forEach((p, idx) => p.classList.toggle("is-lit", idx === step % pills.length));
    step += 1;
  };

  tick();
  const timer = reduced ? null : setInterval(tick, 1850);

  const onPointerMove = (e) => {
    if (reduced || !rig) return;
    const rect = stage.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    const rx = (-ny * 9).toFixed(2);
    const ry = (nx * 11).toFixed(2);
    rig.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  };

  const onPointerLeave = () => {
    if (rig) rig.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg)";
  };

  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerleave", onPointerLeave);

  return () => {
    if (timer) clearInterval(timer);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerleave", onPointerLeave);
  };
}
